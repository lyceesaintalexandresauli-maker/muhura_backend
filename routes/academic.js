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
  ACC: ['S4ACC', 'S5ACC', 'S6ACC'],
};

const cleanText = (value, max) => String(value || '').trim().slice(0, max);
const validYear = (value) => /^\d{4}(?:-\d{4})?$/.test(String(value || '').trim());
const parseWeights = (body) => {
  const cat = Number(body?.cat_weight);
  const practical = Number(body?.practical_weight);
  const exam = Number(body?.exam_weight);
  if (![cat, practical, exam].every(Number.isFinite) ||
      [cat, practical, exam].some((value) => value < 0 || value > 100) ||
      Math.round((cat + practical + exam) * 100) / 100 !== 100) {
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
  const score = (Number(row.cat_score || 0) * Number(module.cat_weight) +
    Number(row.practical_score || 0) * Number(module.practical_weight) +
    Number(row.exam_score || 0) * Number(module.exam_weight)) / 100;
  return Math.round(score * 100) / 100;
};

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
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic workflow migration is not applied yet.' });
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
    if (!teacher.rows.length) return res.status(400).json({ error: 'The selected account is not an active teacher.' });

    const duplicate = await pool.query(
      `SELECT id FROM academic_modules
       WHERE class_level = $1 AND academic_year = $2 AND term = $3
         AND (UPPER(TRIM(module_code)) = $4 OR LOWER(TRIM(module_name)) = LOWER($5))`,
      [m.classLevel, m.academicYear, m.term, m.moduleCode, m.moduleName]
    );
    if (duplicate.rows.length) return res.status(409).json({ error: 'This module is already allocated to the selected class and term.' });

    const result = await pool.query(
      `INSERT INTO academic_modules
       (module_code, module_name, program_code, class_level, teacher_id, academic_year, term,
        cat_weight, practical_weight, exam_weight, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [m.moduleCode, m.moduleName, m.programCode, m.classLevel, m.teacherId, m.academicYear, m.term,
       m.cat, m.practical, m.exam, req.user.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Academic] Module allocation failed:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'A module with this code or name is already allocated to this class and term.' });
    if (err.code === '42P01') return res.status(503).json({ error: 'Apply the academic workflow migration first.' });
    return res.status(500).json({ error: 'Unable to allocate this module.' });
  }
});

router.get('/modules/:id/sheet', ...staffAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid module.' });
  try {
    const module = await getModule(id);
    if (!module || !module.is_active) return res.status(404).json({ error: 'Module not found.' });
    if (!canAccessModule(req, module)) return res.status(403).json({ error: 'This module is not assigned to your account.' });

    const result = await pool.query(
      `SELECT s.id, s.student_code, s.first_name, s.last_name, s.class_level,
        am.cat_score, am.practical_score, am.exam_score, am.final_score, am.updated_at
       FROM students s
       LEFT JOIN academic_marks am ON am.student_id = s.id AND am.module_id = $1
       WHERE s.is_active = TRUE AND s.class_level = $2
       ORDER BY s.last_name, s.first_name`,
      [id, module.class_level]
    );
    return res.json({ module, students: result.rows });
  } catch (err) {
    console.error('[Academic] Marks sheet load failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic workflow migration is not applied yet.' });
    return res.status(500).json({ error: 'Unable to load this marks sheet.' });
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
    const moduleResult = await client.query('SELECT * FROM academic_modules WHERE id = $1 AND is_active = TRUE FOR UPDATE', [id]);
    const module = moduleResult.rows[0];
    if (!module) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Module not found.' }); }
    if (!canAccessModule(req, module)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'This module is not assigned to your account.' }); }
    if (req.user.role !== 'admin' && module.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This marks sheet has been submitted. Ask the administrator to reopen it.' });
    }

    const validStudents = await client.query(
      'SELECT id FROM students WHERE is_active = TRUE AND class_level = $1',
      [module.class_level]
    );
    const allowed = new Set(validStudents.rows.map((row) => Number(row.id)));
    const seen = new Set();
    for (const row of marks) {
      const studentId = Number(row?.student_id);
      if (!Number.isInteger(studentId) || !allowed.has(studentId) || seen.has(studentId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The marks list contains an invalid or repeated student.' });
      }
      seen.add(studentId);
      const normalized = {};
      for (const key of ['cat_score', 'practical_score', 'exam_score']) {
        const value = row[key] === '' || row[key] === null || row[key] === undefined ? null : Number(row[key]);
        if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Enter valid ${key.replace('_', ' ')} values between 0 and 100.` });
        }
        normalized[key] = value;
      }
      const finalScore = calculateFinal(normalized, module);
      await client.query(
        `INSERT INTO academic_marks (module_id, student_id, cat_score, practical_score, exam_score, final_score, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (module_id, student_id)
         DO UPDATE SET cat_score = EXCLUDED.cat_score, practical_score = EXCLUDED.practical_score,
           exam_score = EXCLUDED.exam_score, final_score = EXCLUDED.final_score,
           updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [id, studentId, normalized.cat_score, normalized.practical_score, normalized.exam_score, finalScore, req.user.id]
      );
    }
    await client.query('COMMIT');
    return res.json({ message: 'Marks saved successfully.', saved_count: marks.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Academic] Marks save failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Academic workflow migration is not applied yet.' });
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
    if (req.user.role !== 'admin' && module.status !== 'draft') return res.status(409).json({ error: 'This marks sheet has already been submitted.' });

    const missing = await pool.query(
      `SELECT s.id, s.student_code, s.first_name, s.last_name, am.cat_score, am.practical_score, am.exam_score, am.final_score
       FROM students s
       LEFT JOIN academic_marks am ON am.student_id = s.id AND am.module_id = $1
       WHERE s.is_active = TRUE AND s.class_level = $2
         AND (am.id IS NULL
           OR ($3 > 0 AND am.cat_score IS NULL)
           OR ($4 > 0 AND am.practical_score IS NULL)
           OR ($5 > 0 AND am.exam_score IS NULL)
           OR am.final_score IS NULL)
       ORDER BY s.last_name, s.first_name`,
      [id, module.class_level, module.cat_weight, module.practical_weight, module.exam_weight]
    );
    if (missing.rows.length) {
      return res.status(400).json({
        error: `${missing.rows.length} student mark sheet(s) are incomplete. Complete every required assessment before submitting.`,
        missing_students: missing.rows.slice(0, 20).map((row) => `${row.student_code || row.id} ${row.first_name} ${row.last_name}`),
      });
    }
    await pool.query(
      `UPDATE academic_modules SET status = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    return res.json({ message: 'Marks sheet submitted to the administrator.' });
  } catch (err) {
    console.error('[Academic] Sheet submission failed:', err);
    return res.status(500).json({ error: 'Unable to submit this marks sheet.' });
  }
});

router.post('/modules/:id/reopen', ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE academic_modules SET status = 'draft', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = TRUE RETURNING id, status`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Module not found.' });
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
    const notSubmitted = modules.filter((module) => !['submitted', 'generated'].includes(module.status));
    if (notSubmitted.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${notSubmitted.length} module sheet(s) are still awaiting teacher submission.`, pending_modules: notSubmitted.map((module) => module.module_name) });
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

    const marksByModule = new Map();
    for (const module of modules) {
      const markResult = await client.query(
        `SELECT am.* FROM academic_marks am
         JOIN students s ON s.id = am.student_id
         WHERE am.module_id = $1 AND s.is_active = TRUE AND s.class_level = $2`,
        [module.id, classLevel]
      );
      const byStudent = new Map(markResult.rows.map((mark) => [Number(mark.student_id), mark]));
      for (const student of students) {
        const mark = byStudent.get(Number(student.id));
        if (!mark || mark.final_score === null || mark.final_score === undefined) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Marks are incomplete for at least one student in ${module.module_name}.` });
        }
      }
      marksByModule.set(Number(module.id), byStudent);
    }

    for (const student of students) {
      const savedResult = await client.query(
        `INSERT INTO student_results (student_id, program_code, academic_year, term, is_published, created_by, updated_by)
         VALUES ($1,$2,$3,$4,FALSE,$5,$5)
         ON CONFLICT (student_id, program_code, academic_year, term)
         DO UPDATE SET is_published = FALSE, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [student.id, programCode, academicYear, term, req.user.id]
      );
      const resultId = savedResult.rows[0].id;
      for (const module of modules) {
        const mark = marksByModule.get(Number(module.id)).get(Number(student.id));
        const subjectName = cleanText(module.module_name, 100);
        const existing = await client.query(
          `SELECT id FROM student_result_subjects
           WHERE result_id = $1 AND LOWER(TRIM(subject_name)) = LOWER(TRIM($2))
           LIMIT 1`,
          [resultId, subjectName]
        );
        if (existing.rows.length) {
          await client.query(
            `UPDATE student_result_subjects SET score = $1, max_score = 100 WHERE id = $2`,
            [mark.final_score, existing.rows[0].id]
          );
        } else {
          await client.query(
            `INSERT INTO student_result_subjects (result_id, subject_name, score, max_score)
             VALUES ($1,$2,$3,100)`,
            [resultId, subjectName, mark.final_score]
          );
        }
      }
    }

    await client.query(
      `UPDATE academic_modules SET status = 'generated', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::int[])`,
      [modules.map((module) => module.id)]
    );
    await client.query('COMMIT');
    return res.json({
      message: 'Class results generated. Review them and publish when ready.',
      class_level: classLevel,
      program_code: programCode,
      academic_year: academicYear,
      term,
      student_count: students.length,
      module_count: modules.length,
      published: false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Academic] Result generation failed:', err);
    if (err.code === '42P01') return res.status(503).json({ error: 'Apply the academic workflow and student results migrations first.' });
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
        COUNT(*) FILTER (WHERE status = 'generated')::int AS generated
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
    if (!result.rowCount) return res.status(404).json({ error: 'No generated results were found for this class and term.' });
    return res.json({ message: 'Results published successfully.', published_records: result.rowCount });
  } catch (err) {
    console.error('[Academic] Publish failed:', err);
    return res.status(500).json({ error: 'Unable to publish these results.' });
  }
});

module.exports = router;
