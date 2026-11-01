const express = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { Readable } = require('stream');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const importFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = file.originalname.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx', 'json'].includes(extension)) {
      return callback(new Error('Import only supports CSV, XLSX, or JSON files'));
    }
    return callback(null, true);
  },
});
const parseImportUpload = (req, res, next) => importFileUpload.single('file')(req, res, (error) => {
  if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
  return next();
});
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const recordsAccess = [authenticateToken, authorizeRoles('admin', 'teacher', 'secretary', 'dos')];
const portalAccess = [authenticateToken, authorizeRoles('student', 'parent')];
const backupTables = [
  'users', 'academic_years', 'academic_programs', 'academic_terms', 'academic_classes',
  'academic_subjects', 'class_subjects', 'students', 'staff', 'school_workers',
  'student_results', 'student_result_subjects', 'teacher_assignments', 'examinations',
  'examination_marks', 'student_enrollments', 'student_user_links',
  'attendance_sessions', 'attendance_records', 'discipline_records',
  'student_transitions', 'graduation_records', 'student_documents',
  'grade_scale', 'role_permissions', 'school_admin_settings', 'content', 'events',
  'announcements', 'departments', 'contact_info', 'contact_messages',
  'files', 'gallery', 'navigation_items', 'site_settings', 'timetables',
  'teacher_timetables', 'timetable_distributions'
];

const parseId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const asText = (value, maxLength = 1000) => String(value ?? '').trim().slice(0, maxLength);

const handleError = (res, error, action) => {
  console.error(`[School Admin] ${action} failed:`, error);
  if (error.code === '23505') return res.status(409).json({ error: 'A record with the same unique values already exists' });
  if (error.code === '23503') return res.status(400).json({ error: 'A referenced record does not exist or is still in use' });
  if (error.code === '23514') return res.status(400).json({ error: 'A value does not satisfy the school data rules' });
  if (error.code === '42P01' || error.code === '42703') {
    return res.status(503).json({
      error: 'School operations tables are missing or outdated. Apply the 2026-11-02 school admin operations migration.',
      code: 'SCHOOL_ADMIN_MIGRATION_REQUIRED',
    });
  }
  return res.status(500).json({ error: `Unable to ${action.toLowerCase()}` });
};

const getLinkedStudentIds = async (userId) => {
  const result = await pool.query(
    'SELECT student_id FROM student_user_links WHERE user_id = $1 ORDER BY is_primary DESC, student_id',
    [userId]
  );
  return result.rows.map((row) => row.student_id);
};

const ensureStudentInClass = async (client, studentIds, classId) => {
  const result = await client.query(
    `SELECT s.id
     FROM students s
     JOIN academic_classes c ON c.id = $2
     JOIN academic_programs p ON p.id = c.program_id
     WHERE s.id = ANY($1::integer[]) AND s.is_active = TRUE
       AND (
         s.academic_class_id = c.id
         OR (
           UPPER(TRIM(s.class_level)) = UPPER(TRIM(c.level))
           AND UPPER(TRIM(s.department)) = UPPER(TRIM(p.code))
         )
         OR EXISTS (
           SELECT 1 FROM student_enrollments se
           WHERE se.student_id = s.id AND se.class_id = c.id AND se.end_date IS NULL
         )
       )`,
    [studentIds, classId]
  );
  return result.rows.map((row) => Number(row.id));
};

const createPdfBuffer = (title, student, rows, summary = '') => new Promise((resolve, reject) => {
  const chunks = [];
  const document = new PDFDocument({ margin: 48, size: 'A4' });
  document.on('data', (chunk) => chunks.push(chunk));
  document.on('end', () => resolve(Buffer.concat(chunks)));
  document.on('error', reject);
  document.fontSize(18).text('Lycee Saint Alexandre Sauli de Muhura', { align: 'center' });
  document.moveDown(0.5).fontSize(15).text(title, { align: 'center' });
  document.moveDown();
  document.fontSize(10).text(`Student: ${student.first_name} ${student.last_name}`);
  document.text(`Student code: ${student.student_code}`);
  document.text(`Program / class: ${student.department || '-'} / ${student.class_level || '-'}`);
  if (summary) document.text(summary);
  document.moveDown();
  for (const row of rows) {
    const text = Array.isArray(row)
      ? row.map((value) => String(value ?? '-')).join('   |   ')
      : String(row);
    document.fontSize(10).text(text, { continued: false });
  }
  document.moveDown(2).fontSize(9).fillColor('#555').text(
    `Generated ${new Date().toISOString()} • Official school record`,
    { align: 'left' }
  );
  document.end();
});

const csvValue = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

const sendExport = async (res, rows, filename, format) => {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Export');
    sheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(32, Math.max(12, key.length + 2)) }));
    sheet.addRows(rows);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(Buffer.from(buffer));
  }
  if (format !== 'csv') return res.status(400).json({ error: 'Export format must be csv or xlsx' });
  const csv = [columns.map(csvValue).join(','), ...rows.map((row) => columns.map((key) => csvValue(row[key])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return res.send(`\uFEFF${csv}`);
};

router.get('/dashboard', ...adminOnly, async (req, res) => {
  try {
    const [students, teachers, staff, classes, years, pending, published, attendance, events] = await Promise.all([
      pool.query('SELECT COUNT(*)::integer AS total, COUNT(*) FILTER (WHERE is_active)::integer AS active FROM students'),
      pool.query("SELECT COUNT(*)::integer AS total FROM users WHERE role = 'teacher' AND is_active = TRUE"),
      pool.query('SELECT (SELECT COUNT(*) FROM staff)::integer + (SELECT COUNT(*) FROM school_workers)::integer AS total'),
      pool.query('SELECT COUNT(*)::integer AS total FROM academic_classes WHERE is_active = TRUE'),
      pool.query('SELECT id, name, start_date, end_date FROM academic_years WHERE is_current = TRUE LIMIT 1'),
      pool.query("SELECT COUNT(*)::integer AS total FROM examination_marks WHERE status IN ('draft', 'submitted')"),
      pool.query('SELECT COUNT(*)::integer AS total FROM student_results WHERE is_published = TRUE'),
      pool.query("SELECT COUNT(*)::integer AS total FROM attendance_records WHERE status IN ('absent', 'late') AND updated_at::date = CURRENT_DATE"),
      pool.query('SELECT COUNT(*)::integer AS total FROM events WHERE created_at >= CURRENT_DATE'),
    ]);
    return res.json({
      students: students.rows[0],
      teachers: teachers.rows[0].total,
      staff: staff.rows[0].total,
      classes: classes.rows[0].total,
      current_academic_year: years.rows[0] || null,
      pending_marks: pending.rows[0].total,
      published_results: published.rows[0].total,
      attendance_alerts_today: attendance.rows[0].total,
      events_today: events.rows[0].total,
    });
  } catch (error) {
    return handleError(res, error, 'Load dashboard');
  }
});

router.get('/attendance', ...recordsAccess, async (req, res) => {
  const classId = req.query.class_id ? parseId(req.query.class_id) : null;
  const date = asText(req.query.date, 10);
  if (req.query.class_id && !classId) return res.status(400).json({ error: 'Choose a valid class' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must use YYYY-MM-DD format' });
  try {
    const values = [];
    const filters = [];
    if (classId) {
      values.push(classId);
      filters.push(`s.class_id = $${values.length}`);
    }
    if (date) {
      values.push(date);
      filters.push(`s.attendance_date = $${values.length}`);
    }
    const result = await pool.query(
      `SELECT s.*, c.name AS class_name,
              COUNT(r.id)::integer AS marked_count,
              COUNT(r.id) FILTER (WHERE r.status = 'present')::integer AS present_count,
              COUNT(r.id) FILTER (WHERE r.status = 'absent')::integer AS absent_count,
              COUNT(r.id) FILTER (WHERE r.status = 'late')::integer AS late_count,
              COUNT(r.id) FILTER (WHERE r.status = 'excused')::integer AS excused_count
       FROM attendance_sessions s
       JOIN academic_classes c ON c.id = s.class_id
       LEFT JOIN attendance_records r ON r.session_id = s.id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       GROUP BY s.id, c.name
       ORDER BY s.attendance_date DESC, s.id DESC
       LIMIT 500`,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'List attendance');
  }
});

router.post('/attendance', ...recordsAccess, async (req, res) => {
  const classId = parseId(req.body?.class_id);
  const classSubjectId = req.body?.class_subject_id ? parseId(req.body.class_subject_id) : null;
  const date = asText(req.body?.attendance_date, 10);
  const records = req.body?.records;
  if (!classId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(records) || !records.length || records.length > 500) {
    return res.status(400).json({ error: 'Choose a class, date, and between 1 and 500 attendance records' });
  }
  const cleaned = [];
  const seen = new Set();
  for (const record of records) {
    const studentId = parseId(record?.student_id);
    const status = asText(record?.status, 20).toLowerCase();
    if (!studentId || !['present', 'absent', 'late', 'excused'].includes(status) || seen.has(studentId)) {
      return res.status(400).json({ error: 'Each attendance row must have a unique student and a valid status' });
    }
    seen.add(studentId);
    cleaned.push({ studentId, status, note: asText(record.note, 500) || null });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (classSubjectId) {
      const assignment = await client.query(
        'SELECT 1 FROM class_subjects WHERE id = $1 AND class_id = $2',
        [classSubjectId, classId]
      );
      if (!assignment.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The subject is not assigned to this class' });
      }
      if (req.user.role === 'teacher') {
        const access = await client.query(
          'SELECT 1 FROM teacher_assignments WHERE teacher_id = $1 AND class_subject_id = $2',
          [req.user.id, classSubjectId]
        );
        if (!access.rowCount) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'You are not assigned to this class subject' });
        }
      }
    } else if (req.user.role === 'teacher') {
      const access = await client.query(
        `SELECT 1 FROM teacher_assignments ta
         JOIN class_subjects cs ON cs.id = ta.class_subject_id
         WHERE ta.teacher_id = $1 AND cs.class_id = $2 LIMIT 1`,
        [req.user.id, classId]
      );
      if (!access.rowCount) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You are not assigned to this class' });
      }
    }
    const classExists = await client.query('SELECT 1 FROM academic_classes WHERE id = $1', [classId]);
    if (!classExists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Class not found' });
    }
    const activeStudents = await ensureStudentInClass(client, cleaned.map((row) => row.studentId), classId);
    if (activeStudents.length !== cleaned.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Attendance contains a student who is inactive or not enrolled in this class' });
    }
    const session = await client.query(
      `INSERT INTO attendance_sessions (class_id, class_subject_id, attendance_date, session_label, recorded_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (class_id, (COALESCE(class_subject_id, 0)), attendance_date, (COALESCE(session_label, '')))
       DO UPDATE SET recorded_by = EXCLUDED.recorded_by
       RETURNING id`,
      [classId, classSubjectId, date, asText(req.body?.session_label, 80) || 'Full day', req.user.id]
    );
    for (const record of cleaned) {
      await client.query(
        `INSERT INTO attendance_records (session_id, student_id, status, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, student_id)
         DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
                       recorded_by = EXCLUDED.recorded_by, updated_at = CURRENT_TIMESTAMP`,
        [session.rows[0].id, record.studentId, record.status, record.note, req.user.id]
      );
    }
    if (req.body?.submit === true) {
      await client.query("UPDATE attendance_sessions SET status = 'submitted' WHERE id = $1", [session.rows[0].id]);
    }
    await client.query('COMMIT');
    return res.status(201).json({ session_id: session.rows[0].id, count: cleaned.length });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Save attendance');
  } finally {
    client.release();
  }
});

router.get('/discipline', ...adminOnly, async (req, res) => {
  const studentId = req.query.student_id ? parseId(req.query.student_id) : null;
  if (req.query.student_id && !studentId) return res.status(400).json({ error: 'Choose a valid student' });
  try {
    const result = await pool.query(
      `SELECT d.*, s.student_code, s.first_name, s.last_name, u.full_name AS reporter
       FROM discipline_records d
       JOIN students s ON s.id = d.student_id
       LEFT JOIN users u ON u.id = d.reported_by
       WHERE ($1::integer IS NULL OR d.student_id = $1)
       ORDER BY d.incident_date DESC, d.id DESC
       LIMIT 1000`,
      [studentId]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'List discipline records');
  }
});

router.post('/discipline', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.body?.student_id);
  const incidentDate = asText(req.body?.incident_date, 10) || new Date().toISOString().slice(0, 10);
  const category = asText(req.body?.category, 60);
  const severity = asText(req.body?.severity, 20).toLowerCase() || 'low';
  const description = asText(req.body?.description, 5000);
  if (!studentId || !/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || !category || !description || !['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Student, valid date, category, description, and severity are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO discipline_records
         (student_id, incident_date, category, severity, description, action_taken, follow_up_date, reported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [studentId, incidentDate, category, severity, description, asText(req.body?.action_taken, 3000) || null, req.body?.follow_up_date || null, req.user.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, 'Create discipline record');
  }
});

router.put('/discipline/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  const status = asText(req.body?.status, 20).toLowerCase();
  if (!id || !['open', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Choose a valid record and status' });
  }
  try {
    const result = await pool.query(
      `UPDATE discipline_records
       SET status = $1, action_taken = COALESCE($2, action_taken), updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [status, req.body?.action_taken ? asText(req.body.action_taken, 3000) : null, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Discipline record not found' });
    return res.json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, 'Update discipline record');
  }
});

router.get('/students/:id/transitions', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  if (!studentId) return res.status(400).json({ error: 'Choose a valid student' });
  try {
    const result = await pool.query(
      `SELECT st.*, from_class.name AS from_class, to_class.name AS to_class, ay.name AS academic_year
       FROM student_transitions st
       LEFT JOIN academic_classes from_class ON from_class.id = st.from_class_id
       LEFT JOIN academic_classes to_class ON to_class.id = st.to_class_id
       LEFT JOIN academic_years ay ON ay.id = st.academic_year_id
       WHERE st.student_id = $1
       ORDER BY st.effective_date DESC, st.id DESC`,
      [studentId]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'List student transitions');
  }
});

router.post('/students/:id/transition', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  const toClassId = req.body?.to_class_id ? parseId(req.body.to_class_id) : null;
  const academicYearId = req.body?.academic_year_id ? parseId(req.body.academic_year_id) : null;
  const type = asText(req.body?.transition_type, 20).toLowerCase();
  const effectiveDate = asText(req.body?.effective_date, 10) || new Date().toISOString().slice(0, 10);
  if (!studentId || !['promoted', 'repeated', 'transferred', 'graduated', 'withdrawn'].includes(type)) {
    return res.status(400).json({ error: 'Choose a valid student and transition type' });
  }
  if (type !== 'graduated' && type !== 'withdrawn' && !toClassId) {
    return res.status(400).json({ error: 'A destination class is required for this transition' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return res.status(400).json({ error: 'Effective date must use YYYY-MM-DD format' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentResult = await client.query('SELECT * FROM students WHERE id = $1 FOR UPDATE', [studentId]);
    if (!studentResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }
    let targetClass = null;
    if (toClassId) {
      const classResult = await client.query(
        `SELECT c.id, c.level, p.code AS program_code
         FROM academic_classes c JOIN academic_programs p ON p.id = c.program_id
         WHERE c.id = $1 AND c.is_active = TRUE`,
        [toClassId]
      );
      if (!classResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Destination class not found or inactive' });
      }
      targetClass = classResult.rows[0];
    }
    const currentClassId = studentResult.rows[0].academic_class_id;
    await client.query(
      `UPDATE student_enrollments SET end_date = $1, status = $2
       WHERE student_id = $3 AND end_date IS NULL`,
      [effectiveDate, type, studentId]
    );
    const transition = await client.query(
      `INSERT INTO student_transitions
         (student_id, from_class_id, to_class_id, academic_year_id, transition_type, effective_date, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [studentId, currentClassId, toClassId, academicYearId, type, effectiveDate, asText(req.body?.reason, 2000) || null, req.user.id]
    );
    if (targetClass) {
      await client.query(
        `UPDATE students SET academic_class_id = $1, class_level = $2, department = $3
         WHERE id = $4`,
        [targetClass.id, targetClass.level, targetClass.program_code, studentId]
      );
      if (academicYearId) {
        await client.query(
          `INSERT INTO student_enrollments (student_id, academic_year_id, class_id, created_by)
           VALUES ($1, $2, $3, $4)`,
          [studentId, academicYearId, targetClass.id, req.user.id]
        );
      }
    }
    if (type === 'withdrawn') {
      await client.query('UPDATE students SET is_active = FALSE, archived_at = CURRENT_TIMESTAMP WHERE id = $1', [studentId]);
    }
    await client.query('COMMIT');
    return res.status(201).json(transition.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Record student transition');
  } finally {
    client.release();
  }
});

router.post('/students/:id/archive', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  if (!studentId) return res.status(400).json({ error: 'Choose a valid student' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const student = await client.query('SELECT academic_class_id, is_active FROM students WHERE id = $1 FOR UPDATE', [studentId]);
    if (!student.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }
    await client.query(
      'UPDATE students SET is_active = FALSE, archived_at = CURRENT_TIMESTAMP WHERE id = $1',
      [studentId]
    );
    await client.query(
      `UPDATE student_enrollments SET end_date = CURRENT_DATE, status = 'withdrawn'
       WHERE student_id = $1 AND end_date IS NULL`,
      [studentId]
    );
    await client.query(
      `INSERT INTO student_transitions (student_id, from_class_id, transition_type, reason, created_by)
       VALUES ($1, $2, 'archived', $3, $4)`,
      [studentId, student.rows[0].academic_class_id, asText(req.body?.reason, 2000) || 'Archived by administrator', req.user.id]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Student archived' });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Archive student');
  } finally {
    client.release();
  }
});

router.get('/graduation', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*, s.student_code, s.first_name, s.last_name, p.name AS program_name, ay.name AS academic_year
       FROM graduation_records g
       JOIN students s ON s.id = g.student_id
       JOIN academic_years ay ON ay.id = g.academic_year_id
       LEFT JOIN academic_programs p ON p.id = g.program_id
       ORDER BY ay.start_date DESC, s.last_name, s.first_name`
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'List graduation records');
  }
});

router.post('/graduation', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.body?.student_id);
  const academicYearId = parseId(req.body?.academic_year_id);
  const programId = req.body?.program_id ? parseId(req.body.program_id) : null;
  const status = asText(req.body?.status, 20).toLowerCase() || 'eligible';
  if (!studentId || !academicYearId || !['eligible', 'completed', 'withheld'].includes(status)) {
    return res.status(400).json({ error: 'Student, academic year and a valid graduation status are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO graduation_records
         (student_id, academic_year_id, program_id, status, graduation_date, certificate_number, remarks, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (student_id, academic_year_id)
       DO UPDATE SET program_id = EXCLUDED.program_id, status = EXCLUDED.status,
                     graduation_date = EXCLUDED.graduation_date,
                     certificate_number = EXCLUDED.certificate_number, remarks = EXCLUDED.remarks
       RETURNING *`,
      [
        studentId, academicYearId, programId, status,
        req.body?.graduation_date || null,
        asText(req.body?.certificate_number, 80) || null,
        asText(req.body?.remarks, 2000) || null,
        req.user.id,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, 'Save graduation record');
  }
});

router.get('/students/:id/portal-access', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  if (!studentId) return res.status(400).json({ error: 'Choose a valid student' });
  try {
    const result = await pool.query(
      `SELECT l.*, u.username, u.full_name, u.email, u.role, u.is_active
       FROM student_user_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.student_id = $1
       ORDER BY l.is_primary DESC, u.full_name`,
      [studentId]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'List student portal access');
  }
});

router.post('/students/:id/portal-access', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  const userId = parseId(req.body?.user_id);
  const relationship = asText(req.body?.relationship, 30) || 'parent';
  if (!studentId || !userId) return res.status(400).json({ error: 'Choose a valid student and portal account' });
  try {
    const user = await pool.query(
      "SELECT id, role FROM users WHERE id = $1 AND is_active = TRUE AND role IN ('student', 'parent')",
      [userId]
    );
    if (!user.rowCount) return res.status(400).json({ error: 'Choose an active student or parent account' });
    const student = await pool.query('SELECT 1 FROM students WHERE id = $1', [studentId]);
    if (!student.rowCount) return res.status(404).json({ error: 'Student not found' });
    const result = await pool.query(
      `INSERT INTO student_user_links
         (student_id, user_id, relationship, can_view_results, can_view_attendance, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (student_id, user_id)
       DO UPDATE SET relationship = EXCLUDED.relationship,
                     can_view_results = EXCLUDED.can_view_results,
                     can_view_attendance = EXCLUDED.can_view_attendance,
                     is_primary = EXCLUDED.is_primary
       RETURNING *`,
      [
        studentId,
        userId,
        relationship,
        req.body?.can_view_results !== false,
        req.body?.can_view_attendance !== false,
        req.body?.is_primary === true,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, 'Grant student portal access');
  }
});

router.delete('/students/:studentId/portal-access/:userId', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.studentId);
  const userId = parseId(req.params.userId);
  if (!studentId || !userId) return res.status(400).json({ error: 'Choose valid student and portal account ids' });
  try {
    const result = await pool.query(
      'DELETE FROM student_user_links WHERE student_id = $1 AND user_id = $2 RETURNING id',
      [studentId, userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Portal link not found' });
    return res.json({ message: 'Portal access revoked' });
  } catch (error) {
    return handleError(res, error, 'Revoke student portal access');
  }
});

router.get('/portal/summary', ...portalAccess, async (req, res) => {
  try {
    const studentIds = await getLinkedStudentIds(req.user.id);
    if (!studentIds.length) return res.json({ students: [], published_results: 0, attendance_records: 0 });
    const [students, results, attendance] = await Promise.all([
      pool.query(
        `SELECT s.id, s.student_code, s.first_name, s.last_name, s.department, s.class_level,
                l.relationship, l.can_view_results, l.can_view_attendance
         FROM student_user_links l JOIN students s ON s.id = l.student_id
         WHERE l.user_id = $1 AND s.is_active = TRUE
         ORDER BY l.is_primary DESC, s.last_name, s.first_name`,
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*)::integer AS total
         FROM student_results WHERE student_id = ANY($1::integer[]) AND is_published = TRUE`,
        [studentIds]
      ),
      pool.query(
        `SELECT COUNT(*)::integer AS total
         FROM attendance_records r
         JOIN student_user_links l ON l.student_id = r.student_id
         WHERE l.user_id = $1 AND l.can_view_attendance = TRUE`,
        [req.user.id]
      ),
    ]);
    return res.json({
      students: students.rows,
      published_results: results.rows[0].total,
      attendance_records: attendance.rows[0].total,
    });
  } catch (error) {
    return handleError(res, error, 'Load portal summary');
  }
});

router.get('/portal/results', ...portalAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.student_id, s.student_code, s.first_name, s.last_name,
              r.program_code, r.academic_year, r.term, r.remarks, r.updated_at,
              COALESCE(SUM(sub.score), 0) AS total_marks,
              COALESCE(SUM(sub.max_score), 0) AS maximum_marks,
              COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                'subject_name', sub.subject_name, 'score', sub.score, 'max_score', sub.max_score
              ) ORDER BY sub.subject_name) FILTER (WHERE sub.id IS NOT NULL), '[]'::json) AS subjects
       FROM student_results r
       JOIN student_user_links l ON l.student_id = r.student_id AND l.user_id = $1 AND l.can_view_results = TRUE
       JOIN students s ON s.id = r.student_id
       LEFT JOIN student_result_subjects sub ON sub.result_id = r.id
       WHERE r.is_published = TRUE AND s.is_active = TRUE
       GROUP BY r.id, s.id
       ORDER BY r.academic_year DESC, r.term DESC, r.updated_at DESC
       LIMIT 500`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'Load portal results');
  }
});

router.get('/portal/attendance', ...portalAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.attendance_date, s.session_label, c.name AS class_name,
              r.status, r.note, l.student_id
       FROM student_user_links l
       JOIN attendance_records r ON r.student_id = l.student_id
       JOIN attendance_sessions s ON s.id = r.session_id
       JOIN academic_classes c ON c.id = s.class_id
       WHERE l.user_id = $1 AND l.can_view_attendance = TRUE
       ORDER BY s.attendance_date DESC
       LIMIT 1000`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'Load portal attendance');
  }
});

router.get('/portal/documents', ...portalAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.student_id, d.document_type, d.issued_at, d.academic_year_id, d.term_id,
              s.student_code, s.first_name, s.last_name
       FROM student_documents d
       JOIN student_user_links l ON l.student_id = d.student_id AND l.user_id = $1
       JOIN students s ON s.id = d.student_id
       ORDER BY d.issued_at DESC`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'Load portal documents');
  }
});

router.get('/grade-scale', ...adminOnly, async (req, res) => {
  try {
    const [grades, settings] = await Promise.all([
      pool.query('SELECT * FROM grade_scale ORDER BY sort_order, minimum_percentage DESC'),
      pool.query('SELECT key, value, updated_at FROM school_admin_settings ORDER BY key'),
    ]);
    return res.json({ grades: grades.rows, settings: settings.rows });
  } catch (error) {
    return handleError(res, error, 'Load grading settings');
  }
});

router.put('/grade-scale', ...adminOnly, async (req, res) => {
  const grades = req.body?.grades;
  if (!Array.isArray(grades) || grades.length < 2 || grades.length > 20) {
    return res.status(400).json({ error: 'Provide between 2 and 20 grade bands' });
  }
  const cleaned = grades.map((grade) => ({
    grade: asText(grade.grade, 10),
    minimum: Number(grade.minimum_percentage),
    maximum: Number(grade.maximum_percentage),
    remark: asText(grade.remark, 80) || null,
    passing: grade.is_passing === true,
    order: parseId(grade.sort_order) || 0,
  })).sort((a, b) => b.minimum - a.minimum);
  if (cleaned.some((grade) =>
    !grade.grade || !Number.isFinite(grade.minimum) || !Number.isFinite(grade.maximum)
    || grade.minimum < 0 || grade.maximum > 100 || grade.minimum > grade.maximum
  )) {
    return res.status(400).json({ error: 'Each grade needs a label and valid percentage range from 0 to 100' });
  }
  const orderedLowToHigh = [...cleaned].sort((a, b) => a.minimum - b.minimum);
  for (let index = 1; index < orderedLowToHigh.length; index += 1) {
    if (orderedLowToHigh[index].minimum <= orderedLowToHigh[index - 1].maximum) {
      return res.status(400).json({ error: 'Grade percentage ranges must not overlap' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM grade_scale');
    for (const grade of cleaned) {
      await client.query(
        `INSERT INTO grade_scale (grade, minimum_percentage, maximum_percentage, remark, is_passing, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grade.grade, grade.minimum, grade.maximum, grade.remark, grade.passing, grade.order]
      );
    }
    await client.query('COMMIT');
    return res.json({ grades: cleaned });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Save grading settings');
  } finally {
    client.release();
  }
});

router.put('/settings/:key', ...adminOnly, async (req, res) => {
  const key = asText(req.params.key, 100);
  const value = req.body?.value;
  const allowedKeys = new Set(['grading', 'report_cards', 'academic_rules', 'school']);
  if (!allowedKeys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
    return res.status(400).json({ error: 'Choose a supported settings key and provide a JSON object' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO school_admin_settings (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value), req.user.id]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    return handleError(res, error, 'Save school settings');
  }
});

router.get('/role-permissions', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT role, permission_key, is_allowed, updated_at FROM role_permissions ORDER BY role, permission_key'
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'Load role permissions');
  }
});

router.put('/role-permissions', ...adminOnly, async (req, res) => {
  const allowedRoles = new Set(['teacher', 'secretary', 'dos', 'parent', 'student']);
  const entries = req.body?.permissions;
  if (!Array.isArray(entries) || entries.length > 200) {
    return res.status(400).json({ error: 'Provide a list of up to 200 role permissions' });
  }
  const cleaned = entries.map((entry) => ({
    role: asText(entry?.role, 20),
    key: asText(entry?.permission_key, 100),
    allowed: entry?.is_allowed,
  }));
  if (cleaned.some((entry) =>
    !allowedRoles.has(entry.role) || !/^[a-z][a-z0-9._-]{1,99}$/i.test(entry.key) || typeof entry.allowed !== 'boolean'
  )) {
    return res.status(400).json({ error: 'Each permission needs a supported role, key, and boolean access value' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of cleaned) {
      await client.query(
        `INSERT INTO role_permissions (role, permission_key, is_allowed, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (role, permission_key)
         DO UPDATE SET is_allowed = EXCLUDED.is_allowed, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [entry.role, entry.key, entry.allowed, req.user.id]
      );
    }
    await client.query('COMMIT');
    return res.json({ updated: cleaned.length });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Save role permissions');
  } finally {
    client.release();
  }
});

router.get('/audit-logs', ...adminOnly, async (req, res) => {
  const limit = Math.min(parseId(req.query.limit) || 100, 1000);
  try {
    const result = await pool.query(
      `SELECT l.*, u.username, u.full_name
       FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.actor_id
       ORDER BY l.created_at DESC LIMIT $1`,
      [limit]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleError(res, error, 'Load audit logs');
  }
});

router.get('/reports/students/:id', ...adminOnly, async (req, res) => {
  const studentId = parseId(req.params.id);
  const documentType = asText(req.query.type, 30) || 'report_card';
  if (!studentId || !['report_card', 'transcript', 'certificate'].includes(documentType)) {
    return res.status(400).json({ error: 'Choose a student and report_card, transcript, or certificate document type' });
  }
  try {
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
    if (!studentResult.rowCount) return res.status(404).json({ error: 'Student not found' });
    const student = studentResult.rows[0];
    let rows = [];
    let academicYearId = null;
    let termId = null;
    let summary = '';
    if (documentType === 'certificate') {
      const graduation = await pool.query(
        `SELECT g.*, ay.name AS academic_year, p.name AS program_name
         FROM graduation_records g
         JOIN academic_years ay ON ay.id = g.academic_year_id
         LEFT JOIN academic_programs p ON p.id = g.program_id
         WHERE g.student_id = $1 AND g.status = 'completed'
         ORDER BY ay.start_date DESC LIMIT 1`,
        [studentId]
      );
      if (!graduation.rowCount) return res.status(404).json({ error: 'No completed graduation record is available for this student' });
      rows = [
        `Program: ${graduation.rows[0].program_name || student.department || '-'}`,
        `Academic year: ${graduation.rows[0].academic_year}`,
        `Certificate number: ${graduation.rows[0].certificate_number || 'Not assigned'}`,
        `Graduation date: ${graduation.rows[0].graduation_date || 'Not recorded'}`,
      ];
      academicYearId = graduation.rows[0].academic_year_id;
    } else {
      const results = await pool.query(
        `SELECT r.id, r.program_code, r.academic_year, r.term, r.remarks, r.is_published,
                r.student_id, s.student_code,
                COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
                  'subject_name', sub.subject_name, 'score', sub.score, 'max_score', sub.max_score
                ) ORDER BY sub.subject_name) FILTER (WHERE sub.id IS NOT NULL), '[]'::json) AS subjects
         FROM student_results r JOIN students s ON s.id = r.student_id
         LEFT JOIN student_result_subjects sub ON sub.result_id = r.id
         WHERE r.student_id = $1
           AND ($2::text IS NULL OR r.academic_year = $2)
           AND ($3::text IS NULL OR r.term = $3)
           AND ($4::boolean = FALSE OR r.is_published = TRUE)
         GROUP BY r.id, s.id
         ORDER BY r.academic_year, r.term`,
        [
          studentId,
          req.query.academic_year ? asText(req.query.academic_year, 20) : null,
          req.query.term ? asText(req.query.term, 30) : null,
          documentType === 'report_card' || documentType === 'transcript' || req.query.published_only === 'true',
        ]
      );
      if (!results.rowCount) return res.status(404).json({ error: 'No academic results are available for this selection' });
      rows = results.rows.flatMap((result) => {
        const total = result.subjects.reduce((sum, subject) => sum + Number(subject.score), 0);
        const maximum = result.subjects.reduce((sum, subject) => sum + Number(subject.max_score), 0);
        const percent = maximum ? (total / maximum) * 100 : 0;
        const header = [
          `Academic year ${result.academic_year} • ${result.term}`,
          `Subject | Mark | Maximum`,
        ];
        return [
          ...header,
          ...result.subjects.map((subject) => `${subject.subject_name} | ${subject.score} | ${subject.max_score}`),
          `Total: ${total.toFixed(2)} / ${maximum.toFixed(2)} (${percent.toFixed(2)}%)`,
          `Remarks: ${result.remarks || '-'}`,
          ' ',
        ];
      });
      academicYearId = null;
      termId = null;
      summary = documentType === 'report_card'
        ? `Report period: ${asText(req.query.academic_year, 20) || 'All published terms'} ${asText(req.query.term, 30)}`
        : 'Academic transcript';
    }
    const title = documentType === 'report_card' ? 'Student Report Card'
      : documentType === 'transcript' ? 'Academic Transcript' : 'Certificate of Graduation';
    const content = await createPdfBuffer(title, student, rows, summary);
    const inserted = await pool.query(
      `INSERT INTO student_documents
         (student_id, document_type, academic_year_id, term_id, file_path, content, issued_by, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb)
       RETURNING id`,
      [studentId, documentType, academicYearId, termId, content, req.user.id, JSON.stringify({ title, summary })]
    );
    const id = inserted.rows[0].id;
    const filePath = `/api/school-admin/documents/${id}/download`;
    await pool.query('UPDATE student_documents SET file_path = $1 WHERE id = $2', [filePath, id]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${documentType}-${student.student_code}.pdf"`);
    return res.send(content);
  } catch (error) {
    return handleError(res, error, 'Generate student document');
  }
});

router.get('/documents/:id/download', authenticateToken, async (req, res) => {
  const documentId = parseId(req.params.id);
  if (!documentId) return res.status(400).json({ error: 'Choose a valid document' });
  try {
    const result = await pool.query(
      `SELECT d.*, s.student_code
       FROM student_documents d JOIN students s ON s.id = d.student_id
       WHERE d.id = $1`,
      [documentId]
    );
    const record = result.rows[0];
    if (!record) return res.status(404).json({ error: 'Document not found' });
    if (req.user.role !== 'admin') {
      const access = await pool.query(
        `SELECT 1 FROM student_user_links
         WHERE user_id = $1 AND student_id = $2
           AND ($3::text <> 'report_card' OR can_view_results = TRUE)`,
        [req.user.id, record.student_id, record.document_type]
      );
      if (!access.rowCount) return res.status(403).json({ error: 'You do not have access to this student document' });
    }
    if (!record.content) return res.status(404).json({ error: 'The generated document content is unavailable' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${record.document_type}-${record.student_code}.pdf"`);
    return res.send(record.content);
  } catch (error) {
    return handleError(res, error, 'Download student document');
  }
});

router.get('/export/:kind', ...adminOnly, async (req, res) => {
  const kind = asText(req.params.kind, 20).toLowerCase();
  const queries = {
    students: `SELECT student_code, first_name, last_name, gender, date_of_birth, department, class_level,
                      parent_name, parent_phone, email, address, is_active, created_at
               FROM students ORDER BY student_code`,
    teachers: `SELECT id, username, full_name, email, phone, role, is_active, created_at
               FROM users WHERE role = 'teacher' ORDER BY full_name`,
    marks: `SELECT s.student_code, s.first_name, s.last_name, r.program_code, r.academic_year, r.term,
                   sub.subject_name, sub.score, sub.max_score, r.is_published
            FROM student_result_subjects sub
            JOIN student_results r ON r.id = sub.result_id
            JOIN students s ON s.id = r.student_id
            ORDER BY r.academic_year, r.term, s.student_code, sub.subject_name`,
    results: `SELECT s.student_code, s.first_name, s.last_name, r.program_code, r.academic_year, r.term,
                     r.remarks, r.is_published, r.updated_at
              FROM student_results r JOIN students s ON s.id = r.student_id
              ORDER BY r.academic_year, r.term, s.student_code`,
  };
  if (!queries[kind]) return res.status(400).json({ error: 'Export kind must be students, teachers, marks, or results' });
  try {
    const result = await pool.query(queries[kind]);
    return await sendExport(res, result.rows, `${kind}-${new Date().toISOString().slice(0, 10)}`, asText(req.query.format, 10) || 'csv');
  } catch (error) {
    return handleError(res, error, `Export ${kind}`);
  }
});

router.post('/import/:kind', ...adminOnly, parseImportUpload, async (req, res) => {
  const kind = asText(req.params.kind, 20).toLowerCase();
  let records = req.body?.records;
  if (!['students', 'teachers', 'marks'].includes(kind)) {
    return res.status(400).json({ error: 'Import kind must be students, teachers, or marks' });
  }
  if (req.file) {
    try {
      const extension = req.file.originalname.split('.').pop()?.toLowerCase();
      if (extension === 'json') {
        const parsed = JSON.parse(req.file.buffer.toString('utf8'));
        records = Array.isArray(parsed) ? parsed : parsed?.records;
      } else {
        const workbook = new ExcelJS.Workbook();
        if (extension === 'xlsx') {
          await workbook.xlsx.load(req.file.buffer);
        } else {
          await workbook.csv.read(Readable.from([req.file.buffer]));
        }
        const worksheet = workbook.worksheets[0];
        if (!worksheet || worksheet.rowCount < 2) {
          return res.status(400).json({ error: 'Import file must contain a header row and at least one data row' });
        }
        const headers = worksheet.getRow(1).values.slice(1).map((header) => String(header ?? '').trim());
        records = [];
        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const record = {};
          headers.forEach((header, index) => {
            if (!header) return;
            const cell = row.getCell(index + 1).value;
            record[header] = cell && typeof cell === 'object' && 'text' in cell ? cell.text : cell;
          });
          if (Object.values(record).some((value) => value !== null && value !== undefined && value !== '')) {
            records.push(record);
          }
        });
      }
    } catch (error) {
      console.error('[School Admin] Import file parsing failed:', error);
      return res.status(400).json({ error: 'Import file could not be parsed. Check the file format and headers.' });
    }
  }
  if (!Array.isArray(records) || !records.length || records.length > 2000) {
    return res.status(400).json({ error: 'Provide between 1 and 2000 import records' });
  }
  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query('BEGIN');
    for (const [index, record] of records.entries()) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Row ${index + 1} must be an object` });
      }
      if (kind === 'students') {
        const code = asText(record.student_code, 50);
        const firstName = asText(record.first_name, 80);
        const lastName = asText(record.last_name, 80);
        const department = asText(record.department, 50).toUpperCase();
        const classLevel = asText(record.class_level, 30).toUpperCase();
        if (!code || !firstName || !lastName || !department || !classLevel) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Row ${index + 1} requires student_code, first_name, last_name, department, and class_level` });
        }
        await client.query(
          `INSERT INTO students
             (student_code, first_name, last_name, gender, date_of_birth, department, class_level,
              parent_name, parent_phone, email, address, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)`,
          [
            code, firstName, lastName, asText(record.gender, 20) || null, record.date_of_birth || null,
            department, classLevel, asText(record.parent_name, 120) || null,
            asText(record.parent_phone, 30) || null, asText(record.email, 120) || null,
            asText(record.address, 2000) || null,
          ]
        );
      } else if (kind === 'teachers') {
        const name = asText(record.name || record.full_name, 120);
        const position = asText(record.position, 100) || 'Teacher';
        const department = asText(record.department || record.program, 100);
        if (!name || !department) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Row ${index + 1} requires a teacher name and department/program` });
        }
        await client.query(
          `INSERT INTO staff (name, position, department, email, phone, bio)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [name, position, department, asText(record.email, 100) || null, asText(record.phone, 30) || null, asText(record.bio, 2000) || null]
        );
      } else {
        const studentCode = asText(record.student_code, 50);
        const studentId = record.student_id ? parseId(record.student_id) : null;
        const programCode = asText(record.program_code, 10).toUpperCase();
        const academicYear = asText(record.academic_year, 20);
        const term = asText(record.term, 30);
        let subjects = record.subjects;
        if (typeof subjects === 'string') {
          try {
            subjects = JSON.parse(subjects);
          } catch {
            subjects = null;
          }
        }
        if ((!studentId && !studentCode) || !/^[A-Z0-9_-]{2,10}$/.test(programCode)
            || !/^\d{4}(?:-\d{4})?$/.test(academicYear) || !term || !Array.isArray(subjects) || !subjects.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Row ${index + 1} requires a student identifier, program, academic year, term, and subject marks array` });
        }
        const student = await client.query(
          studentId ? 'SELECT id FROM students WHERE id = $1' : 'SELECT id FROM students WHERE student_code = $1',
          [studentId || studentCode]
        );
        if (!student.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Student on row ${index + 1} was not found` });
        }
        const result = await client.query(
          `INSERT INTO student_results (student_id, program_code, academic_year, term, remarks, is_published, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6, $6)
           ON CONFLICT (student_id, program_code, academic_year, term)
           DO UPDATE SET remarks = EXCLUDED.remarks, is_published = FALSE, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
           RETURNING id`,
          [student.rows[0].id, programCode, academicYear, term, asText(record.remarks, 2000) || null, req.user.id]
        );
        await client.query('DELETE FROM student_result_subjects WHERE result_id = $1', [result.rows[0].id]);
        const uniqueSubjects = new Set();
        for (const subject of subjects) {
          const subjectName = asText(subject?.subject_name, 100);
          const score = Number(subject?.score);
          const maxScore = Number(subject?.max_score);
          const normalizedName = subjectName.toLowerCase();
          if (!subjectName || uniqueSubjects.has(normalizedName) || !Number.isFinite(score) || !Number.isFinite(maxScore) || score < 0 || maxScore <= 0 || score > maxScore) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Invalid or duplicate subject mark on row ${index + 1}` });
          }
          uniqueSubjects.add(normalizedName);
          await client.query(
            'INSERT INTO student_result_subjects (result_id, subject_name, score, max_score) VALUES ($1, $2, $3, $4)',
            [result.rows[0].id, subjectName, score, maxScore]
          );
        }
      }
      imported += 1;
    }
    await client.query('COMMIT');
    return res.status(201).json({ imported });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Import contains a duplicate student code or conflicting result' });
    return handleError(res, error, `Import ${kind}`);
  } finally {
    client.release();
  }
});

router.get('/backup', ...adminOnly, async (req, res) => {
  try {
    const tables = {};
    for (const table of backupTables) {
      const result = await pool.query(`SELECT * FROM "${table}" ORDER BY 1`);
      tables[table] = result.rows.map((row) => {
        if (Buffer.isBuffer(row.content)) return { ...row, content: { base64: row.content.toString('base64') } };
        return row;
      });
    }
    const counts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
    const metadata = await pool.query(
      `INSERT INTO admin_backup_exports (created_by, format, record_counts)
       VALUES ($1, 'json', $2::jsonb) RETURNING id, created_at`,
      [req.user.id, JSON.stringify(counts)]
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="school-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.json({
      schema_version: 1,
      created_at: metadata.rows[0].created_at,
      restore_mode: 'merge',
      warning: 'Restore merges records and never deletes existing data.',
      tables,
    });
  } catch (error) {
    return handleError(res, error, 'Create backup');
  }
});

router.post('/backup/restore', ...adminOnly, async (req, res) => {
  const backup = req.body;
  if (!backup || backup.schema_version !== 1 || !backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) {
    return res.status(400).json({ error: 'This is not a supported school backup file' });
  }
  const tableNames = Object.keys(backup.tables);
  if (tableNames.some((table) => !backupTables.includes(table))) {
    return res.status(400).json({ error: 'The backup contains unsupported table names' });
  }
  const totalRows = tableNames.reduce((sum, table) => sum + (Array.isArray(backup.tables[table]) ? backup.tables[table].length : 0), 0);
  if (totalRows > 50000 || tableNames.some((table) => !Array.isArray(backup.tables[table]) || backup.tables[table].length > 10000)) {
    return res.status(413).json({ error: 'Backup exceeds the maximum restore size' });
  }
  if (req.body?.confirm_restore !== 'MERGE') {
    return res.status(400).json({ error: 'Set confirm_restore to MERGE to continue. Existing records will not be deleted.' });
  }
  const client = await pool.connect();
  const restored = {};
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [72811344]);
    for (const table of backupTables.filter((name) => tableNames.includes(name))) {
      const columns = await client.query(
        `SELECT column_name, data_type, is_identity
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table]
      );
      if (!columns.rowCount) throw Object.assign(new Error(`Unknown backup table ${table}`), { code: '42P01' });
      const validColumns = new Map(columns.rows.map((column) => [column.column_name, column]));
      let inserted = 0;
      for (const record of backup.tables[table]) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw Object.assign(new Error('Invalid row in backup'), { code: '22P02' });
        const keys = Object.keys(record);
        if (keys.some((key) => !validColumns.has(key))) throw Object.assign(new Error(`Unknown column in ${table}`), { code: '42703' });
        if (!keys.length) continue;
        const values = keys.map((key) => {
          const value = record[key];
          if (validColumns.get(key).data_type === 'bytea' && value?.base64) return Buffer.from(value.base64, 'base64');
          return value;
        });
        const quotedColumns = keys.map((key) => `"${key}"`).join(', ');
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
        const result = await client.query(
          `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
        inserted += result.rowCount;
      }
      restored[table] = inserted;
    }
    for (const table of backupTables.filter((name) => tableNames.includes(name))) {
      const sequence = await client.query(
        "SELECT pg_get_serial_sequence($1, 'id') AS name",
        [`public.${table}`]
      );
      if (sequence.rows[0].name) {
        await client.query(
          `SELECT setval($1, GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"), 1), 1),
                         EXISTS (SELECT 1 FROM "${table}"))`,
          [sequence.rows[0].name]
        );
      }
    }
    await client.query('COMMIT');
    return res.json({ restored, mode: 'merge', message: 'Backup records merged. Existing records were not deleted or overwritten.' });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleError(res, error, 'Restore backup');
  } finally {
    client.release();
  }
});

module.exports = router;
