const express = require('express');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const staffAccess = [authenticateToken, authorizeRoles('admin', 'teacher')];

const classesByProgram = {
  SWD: ['L3SWD', 'L4SWDA', 'L4SWDB', 'L5SWD'],
  NIT: ['L3NIT', 'L4NITA', 'L4NITB', 'L5NIT'],
  CSA: ['L3CSA', 'L4CSA', 'L5CSA'],
  FAD: ['L3FAD', 'L4FAD', 'L5FAD'],
  ACC: ['S4ACC', 'S5ACC', 'S5ACCA', 'S5ACCB', 'S6ACC'],
};

const EDITABLE_STATUSES = new Set(['draft', 'returned']);
const SUBMITTABLE_STATUSES = new Set(['draft', 'returned']);

const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const validYear = (value) => /^\d{4}(?:-\d{4})?$/.test(String(value || '').trim());

const parseWeights = (body) => {
  const cat = Number(body?.cat_weight);
  const practical = Number(body?.practical_weight);
  const exam = Number(body?.exam_weight);
  if (
    ![cat, practical, exam].every(Number.isFinite) ||
    [cat, practical, exam].some((value) => value < 0 || value > 100) ||
    Math.round((cat + practical + exam) * 100) / 100 !== 100
  ) {
    return { error: 'CAT, practical and examination weights must total exactly 100%.' };
  }
  return { value: { cat, practical, exam } };
};

const validateModule = (body) => {
  const moduleCode = cleanText(body?.module_code, 30).toUpperCase();
  const moduleName = cleanText(body?.module_name, 120);
  const programCode = cleanText(body?.program_code, 10).toUpperCase();
  const classLevel = cleanText(body?.class_level, 30).toUpperCase();
  const academicYear = cleanText(body?.academic_year, 20);
  const term = cleanText(body?.term, 30);
  const teacherId = Number(body?.teacher_id);
  const weights = parseWeights(body);

  if (!moduleCode || !/^[A-Z0-9._-]{2,30}$/.test(moduleCode)) return { error: 'Enter a valid module code.' };
  if (!moduleName) return { error: 'Module name is required.' };
  if (!classesByProgram[programCode]?.includes(classLevel)) return { error: 'Choose a valid class for the selected programme.' };
  if (!validYear(academicYear)) return { error: 'Academic year must look like 2026 or 2026-2027.' };
  if (!term) return { error: 'Choose an academic term.' };
  if (!Number.isInteger(teacherId) || teacherId < 1) return { error: 'Choose an active teacher account.' };
  if (weights.error) return weights;
  return { value: { moduleCode, moduleName, programCode, classLevel, academicYear, term, teacherId, ...weights.value } };
};

const getModule = async (id) => {
  const result = await pool.query(
    `SELECT m.*, u.full_name AS teacher_name, u.email AS teacher_email
     FROM academic_modules m
     JOIN users u ON u.id = m.teacher_id
     WHERE m.id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const canAccessModule = (req, module) =>
  req.user.role === 'admin' || Number(module.teacher_id) === Number(req.user.id);

const calculateFinal = (row, module) => {
  const required = [
    ['cat_score', Number(module.cat_weight)],
    ['practical_score', Number(module.practical_weight)],
    ['exam_score', Number(module.exam_weight)],
  ];
  for (const [key, weight] of required) {
    if (weight > 0 && (row[key] === null || row[key] === undefined || row[key] === '')) return null;
  }
  const score =
    (Number(row.cat_score || 0) * Number(module.cat_weight) +
      Number(row.practical_score || 0) * Number(module.practical_weight) +
      Number(row.exam_score || 0) * Number(module.exam_weight)) /
    100;
  return Math.round(score * 100) / 100;
};

const writeAudit = async (clientOrPool, actorId, action, entityType, entityId, details) => {
  try {
    await clientOrPool.query(
      `INSERT INTO academic_audit_logs (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId || null, action, entityType, entityId || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    if (err.code !== '42P01') console.warn('[Academic] Audit log write failed:', err.message);
  }
};

router.get('/dashboard', ...staffAccess, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const teacherFilter = isAdmin ? '' : 'AND m.teacher_id = $1';
    const teacherValues = isAdmin ? [] : [req.user.id];

    const stats = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM students WHERE is_active = TRUE) AS total_students,
        (SELECT COUNT(*)::int FROM users WHERE role = 'teacher' AND is_active = TRUE) AS total_teachers,
        (SELECT COUNT(DISTINCT class_level)::int FROM students WHERE is_active = TRUE AND class_level IS NOT NULL) AS total_levels,
        (SELECT COUNT(*)::int FROM academic_modules m WHERE m.is_active = TRUE ${teacherFilter}) AS total_modules,
        (SELECT COUNT(*)::int FROM academic_marks am
           JOIN academic_modules m ON m.id = am.module_id
          WHERE m.is_active = TRUE ${teacherFilter}) AS total_marks_entered,
        (SELECT COUNT(*)::int FROM academic_modules m
          WHERE m.is_active = TRUE AND m.status IN ('submitted', 'under_review') ${teacherFilter}) AS awaiting_approval,
        (SELECT COUNT(*)::int FROM academic_modules m
          WHERE m.is_active = TRUE AND m.status IN ('approved', 'generated', 'locked') ${teacherFilter}) AS results_approved,
        (SELECT COUNT(*)::int FROM academic_modules m
          WHERE m.is_active = TRUE AND m.status IN ('generated', 'published') ${teacherFilter}) AS results_generated,
        (SELECT COUNT(*)::int FROM academic_modules m
          WHERE m.is_active = TRUE AND m.status = 'draft' ${teacherFilter}) AS pending_teacher_submission,
        (SELECT COUNT(*)::int FROM academic_modules m
          WHERE m.is_active = TRUE AND m.status = 'returned' ${teacherFilter}) AS returned_for_correction
      `,
      teacherValues
    );

    const recent = await pool.query(
      `SELECT m.id, m.module_code, m.module_name, m.class_level, m.academic_year, m.term,
              m.status, m.updated_at, u.full_name AS teacher_name
       FROM academic_modules m
       JOIN users u ON u.id = m.teacher_id
       WHERE m.is_active = TRUE ${isAdmin ? '' : 'AND m.teacher_id = $1'}
       ORDER BY m.updated_at DESC
       LIMIT 12`,
      teacherValues
    );

    let teachersNotSubmitted = [];
    if (isAdmin) {
      const tns = await pool.query(
        `SELECT u.id, u.full_name, u.email,
                COUNT(*) FILTER (WHERE m.status = 'draft')::int AS draft_count,
                COUNT(*)::int AS total_modules
         FROM users u
         JOIN academic_modules m ON m.teacher_id = u.id AND m.is_active = TRUE
         WHERE u.role = 'teacher' AND u.is_active = TRUE
         GROUP BY u.id, u.full_name, u.email
         HAVING COUNT(*) FILTER (WHERE m.status = 'draft') > 0
         ORDER BY draft_count DESC
         LIMIT 20`
      );
      teachersNotSubmitted = tns.rows;
    }

    return res.json({
      stats: stats.rows[0] || {},
      recent_activity: recent.rows,
      teachers_not_submitted: teachersNotSubmitted,
      role: req.user.role,
    });
  } catch (err) {
    console.error('[Academic] Dashboard failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to load academic dashboard.' });
  }
});

router.get('/teacher-workspace', ...staffAccess, async (req, res) => {
  try {
    const teacherId = req.user.role === 'admin' && req.query.teacher_id
      ? Number(req.query.teacher_id)
      : req.user.id;

    if (!Number.isInteger(teacherId) || teacherId < 1) {
      return res.status(400).json({ error: 'Invalid teacher.' });
    }
    if (req.user.role !== 'admin' && Number(req.user.id) !== teacherId) {
      return res.status(403).json({ error: 'You can only view your own workspace.' });
    }

    const modules = await pool.query(
      `SELECT m.*,
        (SELECT COUNT(*)::int FROM students s WHERE s.is_active = TRUE AND s.class_level = m.class_level) AS student_count,
        (SELECT COUNT(*)::int FROM academic_marks am WHERE am.module_id = m.id) AS saved_marks_count
       FROM academic_modules m
       WHERE m.is_active = TRUE AND m.teacher_id = $1
       ORDER BY m.academic_year DESC, m.term, m.class_level, m.module_name`,
      [teacherId]
    );

    const levelsMap = new Map();
    for (const mod of modules.rows) {
      const key = `${mod.class_level}|${mod.academic_year}|${mod.term}`;
      if (!levelsMap.has(key)) {
        levelsMap.set(key, {
          class_level: mod.class_level,
          program_code: mod.program_code,
          academic_year: mod.academic_year,
          term: mod.term,
          student_count: mod.student_count,
          modules: [],
        });
      }
      levelsMap.get(key).modules.push(mod);
    }

    const teacher = await pool.query(
      `SELECT id, full_name, email, username FROM users WHERE id = $1`,
      [teacherId]
    );

    return res.json({
      teacher: teacher.rows[0] || null,
      levels: Array.from(levelsMap.values()),
      modules: modules.rows,
      totals: {
        levels: levelsMap.size,
        modules: modules.rows.length,
        students: Array.from(levelsMap.values()).reduce((sum, l) => sum + Number(l.student_count || 0), 0),
        pending: modules.rows.filter((m) => m.status === 'draft' || m.status === 'returned').length,
        submitted: modules.rows.filter((m) => m.status === 'submitted' || m.status === 'under_review').length,
        approved: modules.rows.filter((m) => ['approved', 'generated', 'locked', 'published'].includes(m.status)).length,
      },
    });
  } catch (err) {
    console.error('[Academic] Teacher workspace failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to load teacher workspace.' });
  }
});

router.get('/levels', ...staffAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
        (SELECT COUNT(*)::int FROM students s WHERE s.is_active = TRUE AND s.class_level = l.code) AS student_count,
        (SELECT COUNT(*)::int FROM academic_modules m WHERE m.is_active = TRUE AND m.class_level = l.code) AS module_count
       FROM academic_levels l
       WHERE l.is_active = TRUE
       ORDER BY l.sort_order, l.code`
    );
    return res.json(result.rows);
  } catch (err) {
    if (err.code === '42P01') {
      const fallback = [];
      Object.entries(classesByProgram).forEach(([program, levels]) => {
        levels.forEach((code, idx) => fallback.push({ code, name: code, program_code: program, sort_order: idx, student_count: 0, module_count: 0 }));
      });
      return res.json(fallback);
    }
    console.error('[Academic] Levels list failed:', err);
    return res.status(500).json({ error: 'Unable to load levels.' });
  }
});

router.get('/modules', ...staffAccess, async (req, res) => {
  try {
    const values = req.user.role === 'admin' ? [] : [req.user.id];
    const where = req.user.role === 'admin' ? '' : 'WHERE m.teacher_id = $1';
    const result = await pool.query(
      `SELECT m.*, u.full_name AS teacher_name, u.email AS teacher_email,
        (SELECT COUNT(*)::int FROM students s WHERE s.is_active = TRUE AND s.class_level = m.class_level) AS student_count,
        (SELECT COUNT(*)::int FROM academic_marks am WHERE am.module_id = m.id) AS saved_marks_count
       FROM academic_modules m
       JOIN users u ON u.id = m.teacher_id
       ${where}
       ORDER BY m.academic_year DESC, m.term, m.class_level, m.module_name`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[Academic] Modules list failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to load academic modules.' });
  }
});

router.post('/modules', ...adminOnly, async (req, res) => {
  const validation = validateModule(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const m = validation.value;
  try {
    const teacher = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND is_active = TRUE`,
      [m.teacherId]
    );
    if (!teacher.rows.length) return res.status(400).json({ error: 'The selected account is not an active teacher account.' });

    const duplicate = await pool.query(
      `SELECT id FROM academic_modules
       WHERE is_active = TRUE
         AND UPPER(TRIM(module_code)) = $1
         AND class_level = $2
         AND academic_year = $3
         AND term = $4`,
      [m.moduleCode, m.classLevel, m.academicYear, m.term]
    );
    if (duplicate.rows.length) return res.status(409).json({ error: 'This module is already allocated to the selected class and term.' });

    const result = await pool.query(
      `INSERT INTO academic_modules
        (module_code, module_name, program_code, class_level, teacher_id, academic_year, term,
         cat_weight, practical_weight, exam_weight, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
       RETURNING *`,
      [
        m.moduleCode, m.moduleName, m.programCode, m.classLevel, m.teacherId,
        m.academicYear, m.term, m.cat, m.practical, m.exam, req.user.id,
      ]
    );
    await writeAudit(pool, req.user.id, 'allocate_module', 'academic_module', result.rows[0].id, {
      module_code: m.moduleCode,
      class_level: m.classLevel,
      teacher_id: m.teacherId,
    });
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Academic] Module allocation failed:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'A module with this code or name is already allocated to this class and term.' });
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to allocate module.' });
  }
});

/**
 * Bulk-assign multiple modules to one teacher for the same class / year / term.
 * Already-assigned modules (same code + class + year + term) are skipped and
 * treated as disabled for further assignment.
 */
router.post('/modules/bulk', ...adminOnly, async (req, res) => {
  const teacherId = Number(req.body?.teacher_id);
  const programCode = cleanText(req.body?.program_code, 10).toUpperCase();
  const classLevel = cleanText(req.body?.class_level, 30).toUpperCase();
  const academicYear = cleanText(req.body?.academic_year, 20);
  const term = cleanText(req.body?.term, 30);
  const modules = Array.isArray(req.body?.modules) ? req.body.modules : [];
  const weights = parseWeights({
    cat_weight: req.body?.cat_weight ?? 30,
    practical_weight: req.body?.practical_weight ?? 20,
    exam_weight: req.body?.exam_weight ?? 50,
  });

  if (!Number.isInteger(teacherId) || teacherId < 1) {
    return res.status(400).json({ error: 'Choose an active teacher account.' });
  }
  if (!classesByProgram[programCode]?.includes(classLevel)) {
    return res.status(400).json({ error: 'Choose a valid class for the selected programme.' });
  }
  if (!validYear(academicYear)) {
    return res.status(400).json({ error: 'Academic year must look like 2026 or 2026-2027.' });
  }
  if (!term) return res.status(400).json({ error: 'Choose an academic term.' });
  if (weights.error) return res.status(400).json({ error: weights.error });
  if (!modules.length) {
    return res.status(400).json({ error: 'Select at least one module to assign.' });
  }

  const normalized = [];
  const seenCodes = new Set();
  for (const item of modules) {
    const moduleCode = cleanText(item?.module_code, 30).toUpperCase();
    const moduleName = cleanText(item?.module_name, 120);
    if (!moduleCode || !/^[A-Z0-9._-]{2,30}$/.test(moduleCode)) {
      return res.status(400).json({ error: `Invalid module code: ${item?.module_code || '(empty)'}` });
    }
    if (!moduleName) {
      return res.status(400).json({ error: `Module name is required for ${moduleCode}.` });
    }
    if (seenCodes.has(moduleCode)) continue;
    seenCodes.add(moduleCode);
    normalized.push({ moduleCode, moduleName });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const teacher = await client.query(
      `SELECT id, full_name FROM users WHERE id = $1 AND role = 'teacher' AND is_active = TRUE`,
      [teacherId]
    );
    if (!teacher.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The selected account is not an active teacher account.' });
    }

    const created = [];
    const skipped = [];

    for (const mod of normalized) {
      const duplicate = await client.query(
        `SELECT id, teacher_id FROM academic_modules
         WHERE is_active = TRUE
           AND UPPER(TRIM(module_code)) = $1
           AND class_level = $2
           AND academic_year = $3
           AND term = $4`,
        [mod.moduleCode, classLevel, academicYear, term]
      );
      if (duplicate.rows.length) {
        skipped.push({
          module_code: mod.moduleCode,
          module_name: mod.moduleName,
          reason: 'Already assigned for this class and term (disabled for further assignment).',
          existing_id: duplicate.rows[0].id,
        });
        continue;
      }

      const result = await client.query(
        `INSERT INTO academic_modules
          (module_code, module_name, program_code, class_level, teacher_id, academic_year, term,
           cat_weight, practical_weight, exam_weight, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
         RETURNING *`,
        [
          mod.moduleCode,
          mod.moduleName,
          programCode,
          classLevel,
          teacherId,
          academicYear,
          term,
          weights.value.cat,
          weights.value.practical,
          weights.value.exam,
          req.user.id,
        ]
      );
      created.push(result.rows[0]);
      await writeAudit(client, req.user.id, 'allocate_module', 'academic_module', result.rows[0].id, {
        module_code: mod.moduleCode,
        class_level: classLevel,
        teacher_id: teacherId,
        bulk: true,
      });
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message:
        created.length === 0
          ? 'No new modules assigned — all selected modules were already allocated (disabled).'
          : `Assigned ${created.length} module(s) to ${teacher.rows[0].full_name || 'teacher'}.`,
      teacher_id: teacherId,
      teacher_name: teacher.rows[0].full_name,
      class_level: classLevel,
      academic_year: academicYear,
      term,
      created,
      skipped,
      created_count: created.length,
      skipped_count: skipped.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Academic] Bulk module allocation failed:', err);
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.',
        code: 'ACADEMIC_TABLES_MISSING',
      });
    }
    return res.status(500).json({ error: 'Unable to bulk-assign modules.' });
  } finally {
    client.release();
  }
});

router.get('/modules/:id/sheet', ...staffAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid module.' });
  try {
    const module = await getModule(id);
    if (!module || !module.is_active) return res.status(404).json({ error: 'Module not found.' });
    if (!canAccessModule(req, module)) return res.status(403).json({ error: 'This module is not assigned to your account.' });

    const students = await pool.query(
      `SELECT s.id, s.student_code, s.first_name, s.last_name, s.class_level, s.gender,
              am.cat_score, am.practical_score, am.exam_score, am.final_score, am.updated_at AS marks_updated_at
       FROM students s
       LEFT JOIN academic_marks am ON am.student_id = s.id AND am.module_id = $1
       WHERE s.is_active = TRUE AND s.class_level = $2
       ORDER BY s.last_name, s.first_name, s.student_code`,
      [id, module.class_level]
    );

    return res.json({ module, students: students.rows });
  } catch (err) {
    console.error('[Academic] Sheet load failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to load marks sheet.' });
  }
});

router.put('/modules/:id/marks', ...staffAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid module.' });
  const marks = req.body?.marks;
  if (!Array.isArray(marks) || marks.length > 500) return res.status(400).json({ error: 'Submit a valid marks list.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const moduleResult = await client.query(
      'SELECT * FROM academic_modules WHERE id = $1 AND is_active = TRUE FOR UPDATE',
      [id]
    );
    const module = moduleResult.rows[0];
    if (!module) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Module not found.' });
    }
    if (!canAccessModule(req, module)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This module is not assigned to your account.' });
    }
    if (req.user.role !== 'admin' && !EDITABLE_STATUSES.has(module.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This marks sheet has been submitted or locked. Ask the administrator to return or reopen it.',
      });
    }

    const validStudents = await client.query(
      'SELECT id FROM students WHERE is_active = TRUE AND class_level = $1',
      [module.class_level]
    );
    const validIds = new Set(validStudents.rows.map((row) => Number(row.id)));
    const seen = new Set();

    for (const row of marks) {
      const studentId = Number(row.student_id);
      if (!Number.isInteger(studentId) || !validIds.has(studentId) || seen.has(studentId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The marks list contains an invalid or repeated student.' });
      }
      seen.add(studentId);

      for (const key of ['cat_score', 'practical_score', 'exam_score']) {
        if (row[key] === null || row[key] === undefined || row[key] === '') continue;
        const value = Number(row[key]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Enter valid ${key.replace('_', ' ')} values between 0 and 100.` });
        }
      }

      const finalScore = calculateFinal(row, module);
      await client.query(
        `INSERT INTO academic_marks (module_id, student_id, cat_score, practical_score, exam_score, final_score, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (module_id, student_id) DO UPDATE SET
           cat_score = EXCLUDED.cat_score,
           practical_score = EXCLUDED.practical_score,
           exam_score = EXCLUDED.exam_score,
           final_score = EXCLUDED.final_score,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP`,
        [
          id,
          studentId,
          row.cat_score === '' || row.cat_score === undefined ? null : Number(row.cat_score),
          row.practical_score === '' || row.practical_score === undefined ? null : Number(row.practical_score),
          row.exam_score === '' || row.exam_score === undefined ? null : Number(row.exam_score),
          finalScore,
          req.user.id,
        ]
      );
    }

    await client.query(`UPDATE academic_modules SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
    await writeAudit(client, req.user.id, 'save_marks', 'academic_module', id, { saved_count: marks.length });
    await client.query('COMMIT');
    return res.json({ message: 'Marks saved successfully.', saved_count: marks.length, saved_at: new Date().toISOString() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Academic] Save marks failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to save marks.' });
  } finally {
    client.release();
  }
});

router.post('/modules/:id/submit', ...staffAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid module.' });
  try {
    const module = await getModule(id);
    if (!module || !module.is_active) return res.status(404).json({ error: 'Module not found.' });
    if (!canAccessModule(req, module)) return res.status(403).json({ error: 'This module is not assigned to your account.' });
    if (req.user.role !== 'admin' && !SUBMITTABLE_STATUSES.has(module.status)) {
      return res.status(409).json({ error: 'This marks sheet has already been submitted or is locked.' });
    }

    const missing = await pool.query(
      `SELECT s.id
       FROM students s
       LEFT JOIN academic_marks am ON am.student_id = s.id AND am.module_id = $1
       WHERE s.is_active = TRUE AND s.class_level = $2
         AND (
           ($3 > 0 AND (am.cat_score IS NULL)) OR
           ($4 > 0 AND (am.practical_score IS NULL)) OR
           ($5 > 0 AND (am.exam_score IS NULL))
         )`,
      [id, module.class_level, module.cat_weight, module.practical_weight, module.exam_weight]
    );
    if (missing.rows.length) {
      return res.status(400).json({
        error: `${missing.rows.length} student mark sheet(s) are incomplete. Complete every required assessment before submitting.`,
      });
    }

    await pool.query(
      `UPDATE academic_modules
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           review_notes = NULL
       WHERE id = $1`,
      [id]
    );
    await writeAudit(pool, req.user.id, 'submit_marks', 'academic_module', id, null);
    return res.json({ message: 'Marks sheet submitted to the administrator.' });
  } catch (err) {
    console.error('[Academic] Sheet submission failed:', err);
    return res.status(500).json({ error: 'Unable to submit this marks sheet.' });
  }
});

router.post('/modules/:id/review', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE academic_modules
       SET status = 'under_review', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = TRUE AND status IN ('submitted', 'under_review')
       RETURNING id, status`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Module not found or not ready for review.' });
    await writeAudit(pool, req.user.id, 'start_review', 'academic_module', id, null);
    return res.json({ message: 'Submission is now under review.', module: result.rows[0] });
  } catch (err) {
    console.error('[Academic] Review failed:', err);
    return res.status(500).json({ error: 'Unable to start review.' });
  }
});

router.post('/modules/:id/return', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const notes = cleanText(req.body?.notes, 1000);
  try {
    const result = await pool.query(
      `UPDATE academic_modules
       SET status = 'returned', review_notes = $2, returned_at = CURRENT_TIMESTAMP,
           returned_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = TRUE AND status IN ('submitted', 'under_review', 'approved')
       RETURNING id, status, review_notes`,
      [id, notes || null, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Module not found or cannot be returned.' });
    await writeAudit(pool, req.user.id, 'return_marks', 'academic_module', id, { notes });
    return res.json({ message: 'Marks returned to teacher for corrections.', module: result.rows[0] });
  } catch (err) {
    console.error('[Academic] Return failed:', err);
    return res.status(500).json({ error: 'Unable to return marks sheet.' });
  }
});

router.post('/modules/:id/approve', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE academic_modules
       SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = $2,
           updated_at = CURRENT_TIMESTAMP, review_notes = NULL
       WHERE id = $1 AND is_active = TRUE AND status IN ('submitted', 'under_review')
       RETURNING id, status`,
      [id, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Module not found or not awaiting approval.' });
    }
    await writeAudit(pool, req.user.id, 'approve_marks', 'academic_module', id, null);
    return res.json({ message: 'Marks approved and locked.', module: result.rows[0] });
  } catch (err) {
    console.error('[Academic] Approve failed:', err);
    return res.status(500).json({ error: 'Unable to approve marks sheet.' });
  }
});

router.post('/modules/:id/reopen', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE academic_modules
       SET status = 'draft', updated_at = CURRENT_TIMESTAMP,
           submitted_at = NULL, approved_at = NULL, approved_by = NULL,
           returned_at = NULL, returned_by = NULL, review_notes = NULL
       WHERE id = $1 AND is_active = TRUE
       RETURNING id, status`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Module not found.' });
    await writeAudit(pool, req.user.id, 'reopen_marks', 'academic_module', id, null);
    return res.json({ message: 'Marks sheet reopened for editing.', module: result.rows[0] });
  } catch (err) {
    console.error('[Academic] Reopen failed:', err);
    return res.status(500).json({ error: 'Unable to reopen marks sheet.' });
  }
});

router.post('/generate', ...adminOnly, async (req, res) => {
  const programCode = cleanText(req.body?.program_code, 10).toUpperCase();
  const classLevel = cleanText(req.body?.class_level, 30).toUpperCase();
  const academicYear = cleanText(req.body?.academic_year, 20);
  const term = cleanText(req.body?.term, 30);
  if (!classesByProgram[programCode]?.includes(classLevel) || !validYear(academicYear) || !term) {
    return res.status(400).json({ error: 'Choose a valid programme, class, academic year and term.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const modulesResult = await client.query(
      `SELECT * FROM academic_modules
       WHERE is_active = TRUE AND program_code = $1 AND class_level = $2 AND academic_year = $3 AND term = $4
       ORDER BY module_name`,
      [programCode, classLevel, academicYear, term]
    );
    const modules = modulesResult.rows;
    if (!modules.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active modules have been allocated to this class and term.' });
    }

    const notReady = modules.filter(
      (module) => !['approved', 'generated', 'submitted', 'locked'].includes(module.status)
    );
    if (notReady.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${notReady.length} module sheet(s) are not yet approved for result generation.`,
        pending_modules: notReady.map((module) => module.module_name),
      });
    }

    const studentsResult = await client.query(
      `SELECT id FROM students WHERE is_active = TRUE AND class_level = $1 ORDER BY id`,
      [classLevel]
    );
    const students = studentsResult.rows;
    if (!students.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'There are no active students registered in this class.' });
    }

    for (const module of modules) {
      const marksResult = await client.query(`SELECT * FROM academic_marks WHERE module_id = $1`, [module.id]);
      const byStudent = new Map(marksResult.rows.map((row) => [Number(row.student_id), row]));
      for (const student of students) {
        const mark = byStudent.get(Number(student.id));
        if (!mark || calculateFinal(mark, module) === null) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Marks are incomplete for at least one student in ${module.module_name}.` });
        }
      }
    }

    for (const student of students) {
      let totalScore = 0;
      let totalMax = 0;
      const subjects = [];

      for (const module of modules) {
        const markResult = await client.query(
          `SELECT * FROM academic_marks WHERE module_id = $1 AND student_id = $2`,
          [module.id, student.id]
        );
        const mark = markResult.rows[0];
        const finalScore = calculateFinal(mark, module);
        subjects.push({
          subject_name: module.module_name,
          subject_code: module.module_code,
          score: finalScore,
          max_score: 100,
        });
        totalScore += finalScore;
        totalMax += 100;
      }

      const average = totalMax ? Math.round((totalScore / totalMax) * 10000) / 100 : null;

      const existing = await client.query(
        `SELECT id FROM student_results
         WHERE student_id = $1 AND program_code = $2 AND academic_year = $3 AND term = $4`,
        [student.id, programCode, academicYear, term]
      );

      let resultId;
      if (existing.rows.length) {
        await client.query(
          `UPDATE student_results
           SET total_score = $1, average_score = $2, is_published = FALSE,
               updated_by = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [totalScore, average, req.user.id, existing.rows[0].id]
        );
        resultId = existing.rows[0].id;
        await client.query(`DELETE FROM student_result_subjects WHERE result_id = $1`, [resultId]);
      } else {
        const inserted = await client.query(
          `INSERT INTO student_results
            (student_id, program_code, academic_year, term, total_score, average_score, is_published, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $7)
           RETURNING id`,
          [student.id, programCode, academicYear, term, totalScore, average, req.user.id]
        );
        resultId = inserted.rows[0].id;
      }

      for (const subject of subjects) {
        await client.query(
          `INSERT INTO student_result_subjects (result_id, subject_name, subject_code, score, max_score)
           VALUES ($1, $2, $3, $4, $5)`,
          [resultId, subject.subject_name, subject.subject_code, subject.score, subject.max_score]
        );
      }
    }

    await client.query(
      `UPDATE academic_modules
       SET status = 'generated', updated_at = CURRENT_TIMESTAMP
       WHERE is_active = TRUE AND program_code = $1 AND class_level = $2
         AND academic_year = $3 AND term = $4`,
      [programCode, classLevel, academicYear, term]
    );

    await writeAudit(client, req.user.id, 'generate_results', 'class_results', null, {
      program_code: programCode,
      class_level: classLevel,
      academic_year: academicYear,
      term,
      student_count: students.length,
      module_count: modules.length,
    });

    await client.query('COMMIT');
    return res.json({
      message: 'Class results generated successfully.',
      program_code: programCode,
      class_level: classLevel,
      academic_year: academicYear,
      term,
      student_count: students.length,
      module_count: modules.length,
      published: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Academic] Result generation failed:', err);
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    }
    return res.status(500).json({ error: 'Unable to generate class results.' });
  } finally {
    client.release();
  }
});

router.post('/publish', ...adminOnly, async (req, res) => {
  const programCode = cleanText(req.body?.program_code, 10).toUpperCase();
  const classLevel = cleanText(req.body?.class_level, 30).toUpperCase();
  const academicYear = cleanText(req.body?.academic_year, 20);
  const term = cleanText(req.body?.term, 30);
  if (!classesByProgram[programCode]?.includes(classLevel) || !validYear(academicYear) || !term) {
    return res.status(400).json({ error: 'Choose a valid programme, class, academic year and term.' });
  }
  try {
    const workflow = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('generated', 'published'))::int AS generated
       FROM academic_modules
       WHERE is_active = TRUE AND program_code = $1 AND class_level = $2
         AND academic_year = $3 AND term = $4`,
      [programCode, classLevel, academicYear, term]
    );
    if (!workflow.rows[0]?.total || workflow.rows[0].total !== workflow.rows[0].generated) {
      return res.status(409).json({ error: 'Generate results for every allocated module before publishing this class.' });
    }
    const result = await pool.query(
      `UPDATE student_results r
       SET is_published = TRUE, updated_by = $5, updated_at = CURRENT_TIMESTAMP
       FROM students s
       WHERE r.student_id = s.id AND s.is_active = TRUE
         AND s.class_level = $1 AND r.program_code = $2
         AND r.academic_year = $3 AND r.term = $4`,
      [classLevel, programCode, academicYear, term, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'No generated results were found for this class and term.' });
    }

    await pool.query(
      `UPDATE academic_modules
       SET status = 'published', updated_at = CURRENT_TIMESTAMP
       WHERE is_active = TRUE AND program_code = $1 AND class_level = $2
         AND academic_year = $3 AND term = $4`,
      [programCode, classLevel, academicYear, term]
    );

    await writeAudit(pool, req.user.id, 'publish_results', 'class_results', null, {
      program_code: programCode,
      class_level: classLevel,
      academic_year: academicYear,
      term,
      published_records: result.rowCount,
    });

    return res.json({ message: 'Results published successfully.', published_records: result.rowCount });
  } catch (err) {
    console.error('[Academic] Publish failed:', err);
    return res.status(500).json({ error: 'Unable to publish these results.' });
  }
});

router.get('/assignments', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.module_code, m.module_name, m.class_level, m.program_code,
              m.academic_year, m.term, m.status, m.teacher_id,
              u.full_name AS teacher_name, u.email AS teacher_email,
              (SELECT COUNT(*)::int FROM students s WHERE s.is_active = TRUE AND s.class_level = m.class_level) AS student_count
       FROM academic_modules m
       JOIN users u ON u.id = m.teacher_id
       WHERE m.is_active = TRUE
       ORDER BY u.full_name, m.class_level, m.module_name`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[Academic] Assignments list failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic tables are not ready. Open Academic Workflow and click Create academic tables now.', code: 'ACADEMIC_TABLES_MISSING' });
    return res.status(500).json({ error: 'Unable to load teacher assignments.' });
  }
});

router.delete('/modules/:id', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE academic_modules
       SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = TRUE
       RETURNING id`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Module not found.' });
    await writeAudit(pool, req.user.id, 'deactivate_module', 'academic_module', id, null);
    return res.json({ message: 'Module assignment deactivated.' });
  } catch (err) {
    console.error('[Academic] Deactivate failed:', err);
    return res.status(500).json({ error: 'Unable to deactivate module.' });
  }
});


router.post('/modules/:id/deactivate', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid module.' });
  try {
    const module = await getModule(id);
    if (!module) return res.status(404).json({ error: 'Module not found.' });
    if (['submitted', 'under_review', 'approved', 'generated', 'published'].includes(module.status)) {
      return res.status(400).json({ error: 'Cannot disable a module that is already in review or published. Reopen first if needed.' });
    }
    await pool.query('UPDATE academic_modules SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    await writeAudit(pool, req.user.id, 'deactivate_module', 'academic_module', id, {});
    return res.json({ message: 'Module assignment disabled.' });
  } catch (err) {
    console.error('[Academic] Deactivate failed:', err);
    return res.status(500).json({ error: 'Unable to disable module.' });
  }
});


router.get('/setup-status', ...adminOnly, async (req, res) => {
  try {
    const checks = await pool.query(`
      SELECT
        to_regclass('public.academic_modules') IS NOT NULL AS academic_modules,
        to_regclass('public.academic_marks') IS NOT NULL AS academic_marks,
        to_regclass('public.student_results') IS NOT NULL AS student_results,
        to_regclass('public.students') IS NOT NULL AS students
    `);
    return res.json(checks.rows[0] || {});
  } catch (err) {
    console.error('[Academic] setup-status failed:', err);
    return res.status(500).json({ error: 'Unable to check academic tables.' });
  }
});

router.post('/setup', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS academic_modules (
        id SERIAL PRIMARY KEY,
        module_code VARCHAR(30) NOT NULL,
        module_name VARCHAR(120) NOT NULL,
        program_code VARCHAR(10) NOT NULL,
        class_level VARCHAR(30) NOT NULL,
        teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        academic_year VARCHAR(20) NOT NULL,
        term VARCHAR(30) NOT NULL,
        cat_weight NUMERIC(5,2) NOT NULL DEFAULT 30,
        practical_weight NUMERIC(5,2) NOT NULL DEFAULT 20,
        exam_weight NUMERIC(5,2) NOT NULL DEFAULT 50,
        status VARCHAR(30) NOT NULL DEFAULT 'draft',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        review_notes TEXT,
        submitted_at TIMESTAMP,
        submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMP,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        returned_at TIMESTAMP,
        returned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS academic_marks (
        id SERIAL PRIMARY KEY,
        module_id INTEGER NOT NULL REFERENCES academic_modules(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        cat_score NUMERIC(7,2),
        practical_score NUMERIC(7,2),
        exam_score NUMERIC(7,2),
        final_score NUMERIC(7,2),
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (module_id, student_id)
      );
      CREATE TABLE IF NOT EXISTS academic_audit_logs (
        id SERIAL PRIMARY KEY,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(80) NOT NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id INTEGER,
        details JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS student_results (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        program_code VARCHAR(10) NOT NULL,
        academic_year VARCHAR(20) NOT NULL,
        term VARCHAR(30) NOT NULL,
        class_level VARCHAR(30),
        remarks TEXT,
        is_published BOOLEAN NOT NULL DEFAULT FALSE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (student_id, program_code, academic_year, term)
      );
      CREATE TABLE IF NOT EXISTS student_result_subjects (
        id SERIAL PRIMARY KEY,
        result_id INTEGER NOT NULL REFERENCES student_results(id) ON DELETE CASCADE,
        subject_name VARCHAR(100) NOT NULL,
        score NUMERIC(7,2) NOT NULL,
        max_score NUMERIC(7,2) NOT NULL
      );
    `);
    // indexes (ignore if exist)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_modules_code_class_term
        ON academic_modules (UPPER(TRIM(module_code)), class_level, academic_year, term);
      CREATE INDEX IF NOT EXISTS idx_academic_modules_teacher
        ON academic_modules (teacher_id, is_active, academic_year, term);
      CREATE INDEX IF NOT EXISTS idx_academic_modules_status
        ON academic_modules (status, is_active);
    `);
    // expand status check softly
    try {
      await client.query(`ALTER TABLE academic_modules DROP CONSTRAINT IF EXISTS academic_modules_status_check`);
      await client.query(`
        ALTER TABLE academic_modules
          ADD CONSTRAINT academic_modules_status_check
          CHECK (status IN ('draft','submitted','under_review','returned','approved','generated','locked','published'))
      `);
    } catch (e) {
      console.warn('[Academic] status constraint:', e.message);
    }
    await client.query('COMMIT');
    return res.json({
      message: 'Academic and student result tables are ready.',
      academic_modules: true,
      academic_marks: true,
      student_results: true,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Academic] setup failed:', err);
    return res.status(500).json({ error: err.message || 'Unable to create academic tables.' });
  } finally {
    client.release();
  }
});


module.exports = router;
