const express = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Readable } = require('stream');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const markImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = file.originalname.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx'].includes(extension)) {
      return callback(new Error('Marks import supports CSV and XLSX files'));
    }
    return callback(null, true);
  },
});
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const academicAccess = [authenticateToken, authorizeRoles('admin', 'teacher')];

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const asText = (value) => String(value ?? '').trim();
const isValidDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const configs = {
  years: {
    table: 'academic_years',
    fields: ['name', 'start_date', 'end_date', 'is_current'],
    required: ['name', 'start_date', 'end_date'],
    textFields: ['name'],
    dateFields: ['start_date', 'end_date'],
    booleanFields: ['is_current'],
    orderBy: 'start_date DESC, id DESC',
    validate: (body) => {
      const name = asText(body.name);
      if (!/^\d{4}(?:-\d{4})?$/.test(name)) return 'Academic year must be a year such as 2026 or 2026-2027';
      return null;
    },
  },
  terms: {
    table: 'academic_terms',
    fields: ['academic_year_id', 'name', 'start_date', 'end_date', 'status'],
    required: ['academic_year_id', 'name', 'start_date', 'end_date'],
    integerFields: ['academic_year_id'],
    textFields: ['name'],
    dateFields: ['start_date', 'end_date'],
    orderBy: 'academic_year_id DESC, start_date, id',
    validate: async (body) => {
      if (!['active', 'completed', 'upcoming'].includes(asText(body.status || 'active'))) {
        return 'Term status must be active, completed or upcoming';
      }
      const yearId = parseId(body.academic_year_id);
      if (!yearId) return 'Choose a valid academic year';
      const year = await pool.query(
        'SELECT start_date::text, end_date::text FROM academic_years WHERE id = $1',
        [yearId]
      );
      if (!year.rowCount) return 'Choose an existing academic year';
      if (asText(body.start_date) < year.rows[0].start_date || asText(body.end_date) > year.rows[0].end_date) {
        return 'Term dates must fall within the academic year';
      }
      return null;
    },
  },
  programs: {
    table: 'academic_programs',
    fields: ['code', 'name', 'description', 'is_active'],
    required: ['code', 'name'],
    textFields: ['code', 'name', 'description'],
    booleanFields: ['is_active'],
    orderBy: 'name, id',
    validate: (body) => /^[A-Za-z0-9_-]{2,10}$/.test(asText(body.code))
      ? null
      : 'Program code must be 2 to 10 letters, numbers, dashes or underscores',
  },
  classes: {
    table: 'academic_classes',
    fields: ['program_id', 'name', 'level', 'section', 'is_active'],
    required: ['program_id', 'name', 'level'],
    integerFields: ['program_id'],
    textFields: ['name', 'level', 'section'],
    booleanFields: ['is_active'],
    orderBy: 'program_id, level, section, id',
  },
  subjects: {
    table: 'academic_subjects',
    fields: ['code', 'name', 'max_score', 'is_active'],
    required: ['code', 'name', 'max_score'],
    textFields: ['code', 'name'],
    numberFields: ['max_score'],
    booleanFields: ['is_active'],
    orderBy: 'name, id',
    validate: (body) => {
      const maximum = Number(body.max_score);
      return asText(body.code).length <= 20 && Number.isFinite(maximum) && maximum > 0
        ? null
        : 'Enter a subject code up to 20 characters and a positive maximum mark';
    },
  },
  classSubjects: {
    table: 'class_subjects',
    fields: ['class_id', 'subject_id', 'academic_year_id'],
    required: ['class_id', 'subject_id', 'academic_year_id'],
    integerFields: ['class_id', 'subject_id', 'academic_year_id'],
    orderBy: 'academic_year_id DESC, class_id, subject_id',
  },
  assignments: {
    table: 'teacher_assignments',
    fields: ['teacher_id', 'class_subject_id'],
    required: ['teacher_id', 'class_subject_id'],
    integerFields: ['teacher_id', 'class_subject_id'],
    orderBy: 'class_subject_id, teacher_id',
    validate: async (body) => {
      const teacherId = parseId(body.teacher_id);
      if (!teacherId) return 'Choose a valid teacher';
      const teacher = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND is_active = TRUE", [teacherId]);
      return teacher.rowCount ? null : 'Choose an active teacher account';
    },
  },
};

const normalizeBody = (config, body, isUpdate = false) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object' };
  const values = {};
  for (const field of config.fields) {
    if (!(field in body)) {
      if (!isUpdate && config.required.includes(field)) return { error: `${field} is required` };
      continue;
    }
    const raw = body[field];
    if (config.required.includes(field) && (raw === undefined || raw === null || String(raw).trim() === '')) {
      return { error: `${field} is required` };
    }
    if (config.integerFields?.includes(field)) {
      const number = parseId(raw);
      if (number === null && raw !== null && raw !== '') return { error: `${field} must be a positive integer` };
      values[field] = number;
    } else if (config.numberFields?.includes(field)) {
      const number = Number(raw);
      if (!Number.isFinite(number) || number <= 0) return { error: `${field} must be a positive number` };
      values[field] = number;
    } else if (config.booleanFields?.includes(field)) {
      if (typeof raw !== 'boolean') return { error: `${field} must be true or false` };
      values[field] = raw;
    } else if (config.dateFields?.includes(field)) {
      const date = asText(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        return { error: `${field} must be a valid date` };
      }
      values[field] = date;
    } else {
      values[field] = raw === null || raw === undefined || raw === '' ? null : asText(raw);
    }
  }
  return { values };
};

const handleDatabaseError = (res, error, action) => {
  console.error(`[Academics] ${action} failed:`, error);
  if (error.code === '23505') return res.status(409).json({ error: 'A record with the same unique values already exists' });
  if (error.code === '23503') return res.status(409).json({ error: 'This record is in use or references a record that does not exist' });
  if (error.code === '23514') return res.status(400).json({ error: 'A value does not satisfy the academic data rules' });
  if (error.code === '42P01' || error.code === '42703') {
    return res.status(503).json({
      error: 'Academic management tables are missing or outdated. Apply migrations/2026-11-01_academic_assessments.sql.',
      code: 'ACADEMIC_MIGRATION_REQUIRED',
    });
  }
  return res.status(500).json({ error: 'Unable to complete the academic management request' });
};

const parseMarksUpload = (req, res, next) => markImport.single('file')(req, res, (error) => {
  if (!error) return next();
  const status = error instanceof multer.MulterError
    ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    : 400;
  return res.status(status).json({ error: error.message || 'Could not read the marks file' });
});

const readMarksWorkbook = async (file) => {
  const workbook = new ExcelJS.Workbook();
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  if (extension === 'xlsx') await workbook.xlsx.load(file.buffer);
  else await workbook.csv.read(Readable.from([file.buffer]));
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) {
    throw new Error('Marks file must contain a header and at least one student row');
  }
  const headers = worksheet.getRow(1).values.slice(1).map((value) => asText(value).toLowerCase());
  const requiredHeaders = ['student_code', 'score'];
  if (requiredHeaders.some((header) => !headers.includes(header))) {
    throw new Error('Marks file needs student_code and score columns; is_absent is optional');
  }
  const records = [];
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
  if (!records.length || records.length > 1000) {
    throw new Error('Marks file must contain between 1 and 1000 student rows');
  }
  return records;
};

const registerCrudRoutes = (path, config) => {
  router.get(`/${path}`, ...adminOnly, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${config.table} ORDER BY ${config.orderBy}`);
      return res.json(result.rows);
    } catch (error) {
      return handleDatabaseError(res, error, `List ${path}`);
    }
  });

  router.post(`/${path}`, ...adminOnly, async (req, res) => {
    const normalized = normalizeBody(config, req.body);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    try {
      if (config.validate) {
        const validationError = await config.validate(req.body);
        if (validationError) return res.status(400).json({ error: validationError });
      }
      const columns = Object.keys(normalized.values);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const client = await pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        if (path === 'years' && normalized.values.is_current === true) {
          await client.query('UPDATE academic_years SET is_current = FALSE WHERE is_current = TRUE');
        }
        result = await client.query(
          `INSERT INTO ${config.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          columns.map((field) => normalized.values[field])
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      return handleDatabaseError(res, error, `Create ${path}`);
    }
  });

  router.put(`/${path}/:id`, ...adminOnly, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Choose a valid record id' });
    try {
      const current = await pool.query(`SELECT * FROM ${config.table} WHERE id = $1`, [id]);
      if (!current.rowCount) return res.status(404).json({ error: 'Record not found' });
      const validationBody = { ...current.rows[0], ...req.body };
      const normalized = normalizeBody(config, req.body, true);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      if (config.validate) {
        const validationError = await config.validate(validationBody);
        if (validationError) return res.status(400).json({ error: validationError });
      }
      const fields = Object.keys(normalized.values);
      if (!fields.length) return res.status(400).json({ error: 'Provide at least one field to update' });
      const assignments = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
      const client = await pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        if (path === 'years' && normalized.values.is_current === true) {
          await client.query('UPDATE academic_years SET is_current = FALSE WHERE id <> $1 AND is_current = TRUE', [id]);
        }
        result = await client.query(
          `UPDATE ${config.table} SET ${assignments} WHERE id = $${fields.length + 1} RETURNING *`,
          [...fields.map((field) => normalized.values[field]), id]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (!result.rowCount) return res.status(404).json({ error: 'Record not found' });
      return res.json(result.rows[0]);
    } catch (error) {
      return handleDatabaseError(res, error, `Update ${path}`);
    }
  });

  router.delete(`/${path}/:id`, ...adminOnly, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Choose a valid record id' });
    try {
      const result = await pool.query(`DELETE FROM ${config.table} WHERE id = $1 RETURNING id`, [id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Record not found' });
      return res.json({ message: 'Record deleted' });
    } catch (error) {
      return handleDatabaseError(res, error, `Delete ${path}`);
    }
  });
};

for (const [path, config] of Object.entries(configs)) registerCrudRoutes(path, config);

router.get('/structure', ...adminOnly, async (req, res) => {
  try {
    const names = Object.keys(configs);
    const values = await Promise.all(names.map((name) => {
      const config = configs[name];
      return pool.query(`SELECT * FROM ${config.table} ORDER BY ${config.orderBy}`);
    }));
    return res.json(Object.fromEntries(names.map((name, index) => [name, values[index].rows])));
  } catch (error) {
    return handleDatabaseError(res, error, 'Load academic structure');
  }
});

const teacherHasAccess = async (client, user, classSubjectId) => {
  if (user.role === 'admin') return true;
  const result = await client.query(
    'SELECT 1 FROM teacher_assignments WHERE teacher_id = $1 AND class_subject_id = $2',
    [user.id, classSubjectId]
  );
  return result.rowCount > 0;
};

const getExam = async (client, examId) => {
  const result = await client.query(
    `SELECT e.*, cs.class_id, cs.academic_year_id, c.level, c.program_id, p.code AS program_code,
            t.academic_year_id AS term_year_id, t.name AS term_name
     FROM examinations e
     JOIN class_subjects cs ON cs.id = e.class_subject_id
     JOIN academic_classes c ON c.id = cs.class_id
     JOIN academic_programs p ON p.id = c.program_id
     JOIN academic_terms t ON t.id = e.term_id
     WHERE e.id = $1`,
    [examId]
  );
  return result.rows[0] || null;
};

const examAccess = async (client, user, exam) => (
  exam ? teacherHasAccess(client, user, exam.class_subject_id) : false
);

router.get('/exams', ...academicAccess, async (req, res) => {
  try {
    const values = req.user.role === 'teacher' ? [req.user.id] : [];
    const teacherFilter = req.user.role === 'teacher'
      ? 'WHERE EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.class_subject_id = e.class_subject_id AND ta.teacher_id = $1)'
      : '';
    const result = await pool.query(
      `SELECT e.*, cs.class_id, cs.subject_id, cs.academic_year_id, c.name AS class_name, c.level,
              p.code AS program_code, p.name AS program_name, s.name AS subject_name,
              t.name AS term_name, ay.name AS academic_year
       FROM examinations e
       JOIN class_subjects cs ON cs.id = e.class_subject_id
       JOIN academic_classes c ON c.id = cs.class_id
       JOIN academic_programs p ON p.id = c.program_id
       JOIN academic_subjects s ON s.id = cs.subject_id
       JOIN academic_terms t ON t.id = e.term_id
       JOIN academic_years ay ON ay.id = t.academic_year_id
       ${teacherFilter}
       ORDER BY e.created_at DESC
       LIMIT 500`,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    return handleDatabaseError(res, error, 'List examinations');
  }
});

router.post('/exams', ...adminOnly, async (req, res) => {
  const classSubjectId = parseId(req.body?.class_subject_id);
  const termId = parseId(req.body?.term_id);
  const title = asText(req.body?.title);
  const type = asText(req.body?.type).toLowerCase();
  const weight = Number(req.body?.weight);
  const maxScore = Number(req.body?.max_score);
  const examDate = req.body?.exam_date ? asText(req.body.exam_date) : null;
  if (!classSubjectId || !termId || !title || title.length > 120) {
    return res.status(400).json({ error: 'Choose a class subject and term, and enter a title up to 120 characters' });
  }
  if (!['cat', 'practical', 'final', 'oral', 'supplementary', 'other'].includes(type)) {
    return res.status(400).json({ error: 'Examination type must be CAT, practical, final, oral, supplementary or other' });
  }
  if (examDate && !isValidDate(examDate)) {
    return res.status(400).json({ error: 'Examination date must be a valid YYYY-MM-DD date' });
  }
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100 || !Number.isFinite(maxScore) || maxScore <= 0) {
    return res.status(400).json({ error: 'Weight must be 0 to 100 and maximum marks must be positive' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const relation = await client.query(
      `SELECT cs.academic_year_id, t.academic_year_id AS term_year_id
       FROM class_subjects cs CROSS JOIN academic_terms t
       WHERE cs.id = $1 AND t.id = $2
       FOR UPDATE OF cs`,
      [classSubjectId, termId]
    );
    if (!relation.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Class subject or term not found' });
    }
    if (Number(relation.rows[0].academic_year_id) !== Number(relation.rows[0].term_year_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The term must belong to the class subject academic year' });
    }
    const currentWeight = await client.query(
      'SELECT COALESCE(SUM(weight), 0) AS total FROM examinations WHERE class_subject_id = $1 AND term_id = $2',
      [classSubjectId, termId]
    );
    if (Number(currentWeight.rows[0].total) + weight > 100) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The combined examination weights for this subject and term cannot exceed 100%' });
    }
    const result = await client.query(
      `INSERT INTO examinations (class_subject_id, term_id, title, type, weight, max_score, exam_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [classSubjectId, termId, title, type, weight, maxScore, examDate, req.user.id]
    );
    await client.query('COMMIT');
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Create examination');
  } finally {
    client.release();
  }
});

router.put('/exams/:id', ...adminOnly, async (req, res) => {
  const examId = parseId(req.params.id);
  const classSubjectId = parseId(req.body?.class_subject_id);
  const termId = parseId(req.body?.term_id);
  const title = asText(req.body?.title);
  const type = asText(req.body?.type).toLowerCase();
  const weight = Number(req.body?.weight);
  const maxScore = Number(req.body?.max_score);
  const examDate = req.body?.exam_date ? asText(req.body.exam_date) : null;
  if (!examId || !classSubjectId || !termId || !title || title.length > 120) {
    return res.status(400).json({ error: 'Choose a valid class subject and term, and enter a title up to 120 characters' });
  }
  if (!['cat', 'practical', 'final', 'oral', 'supplementary', 'other'].includes(type)) {
    return res.status(400).json({ error: 'Examination type must be CAT, practical, final, oral, supplementary or other' });
  }
  if (examDate && !isValidDate(examDate)) {
    return res.status(400).json({ error: 'Examination date must be a valid YYYY-MM-DD date' });
  }
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100 || !Number.isFinite(maxScore) || maxScore <= 0) {
    return res.status(400).json({ error: 'Weight must be positive and no more than 100; maximum marks must be positive' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const relation = await client.query(
      `SELECT e.status, e.class_subject_id AS existing_class_subject_id, e.term_id AS existing_term_id,
              cs.academic_year_id, t.academic_year_id AS term_year_id
       FROM examinations e
       JOIN class_subjects cs ON cs.id = $2
       JOIN academic_terms t ON t.id = $3
       WHERE e.id = $1
       FOR UPDATE OF e, cs`,
      [examId, classSubjectId, termId]
    );
    if (!relation.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination, class subject or term not found' });
    }
    if (relation.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only open examinations can be edited' });
    }
    if (Number(relation.rows[0].academic_year_id) !== Number(relation.rows[0].term_year_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The term must belong to the class subject academic year' });
    }
    if (
      Number(relation.rows[0].existing_class_subject_id) !== classSubjectId
      || Number(relation.rows[0].existing_term_id) !== termId
    ) {
      const existingMarks = await client.query(
        'SELECT 1 FROM examination_marks WHERE examination_id = $1 LIMIT 1',
        [examId]
      );
      if (existingMarks.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Class subject and term cannot change after marks have been recorded' });
      }
    }
    const currentWeight = await client.query(
      'SELECT COALESCE(SUM(weight), 0) AS total FROM examinations WHERE class_subject_id = $1 AND term_id = $2 AND id <> $3',
      [classSubjectId, termId, examId]
    );
    if (Number(currentWeight.rows[0].total) + weight > 100) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The combined examination weights for this subject and term cannot exceed 100%' });
    }
    const maximumRecordedMark = await client.query(
      'SELECT MAX(score) AS maximum FROM examination_marks WHERE examination_id = $1 AND is_absent = FALSE',
      [examId]
    );
    if (maximumRecordedMark.rows[0].maximum !== null && Number(maximumRecordedMark.rows[0].maximum) > maxScore) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Maximum marks cannot be lower than marks already entered' });
    }
    const updated = await client.query(
      `UPDATE examinations
       SET class_subject_id = $1, term_id = $2, title = $3, type = $4, weight = $5,
           max_score = $6, exam_date = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND status = 'open'
       RETURNING *`,
      [classSubjectId, termId, title, type, weight, maxScore, examDate, examId]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only open examinations can be edited' });
    }
    await client.query('COMMIT');
    return res.json(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Update examination');
  } finally {
    client.release();
  }
});

router.delete('/exams/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Choose a valid examination id' });
  try {
    const result = await pool.query(
      "DELETE FROM examinations WHERE id = $1 AND status = 'open' RETURNING id",
      [id]
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Only open examinations can be deleted' });
    return res.json({ message: 'Examination deleted' });
  } catch (error) {
    return handleDatabaseError(res, error, 'Delete examination');
  }
});

router.get('/exams/:id/marks', ...academicAccess, async (req, res) => {
  const examId = parseId(req.params.id);
  if (!examId) return res.status(400).json({ error: 'Choose a valid examination id' });
  const client = await pool.connect();
  try {
    const exam = await getExam(client, examId);
    if (!exam) return res.status(404).json({ error: 'Examination not found' });
    if (!await examAccess(client, req.user, exam)) return res.status(403).json({ error: 'You are not assigned to this class subject' });
    const result = await client.query(
      `SELECT s.id AS student_id, s.student_code, s.first_name, s.last_name, s.class_level,
              m.id AS mark_id, m.score, m.is_absent, m.status AS mark_status
       FROM students s
       LEFT JOIN examination_marks m ON m.student_id = s.id AND m.examination_id = $1
       WHERE s.is_active = TRUE
         AND (
           UPPER(TRIM(s.department)) = UPPER(TRIM($2))
           OR (UPPER(TRIM($2)) IN ('SWD', 'SOD') AND UPPER(TRIM(s.department)) IN ('SWD', 'SOD'))
         )
         AND REGEXP_REPLACE(UPPER(TRIM(s.class_level)), '[^A-Z0-9]', '', 'g')
             = REGEXP_REPLACE(UPPER(TRIM($3)), '[^A-Z0-9]', '', 'g')
       ORDER BY s.last_name, s.first_name, s.student_code`,
      [examId, exam.program_code, exam.level]
    );
    return res.json({ exam, students: result.rows });
  } catch (error) {
    return handleDatabaseError(res, error, 'Load examination marks');
  } finally {
    client.release();
  }
});

router.post('/exams/:id/marks', ...academicAccess, async (req, res) => {
  const examId = parseId(req.params.id);
  const marks = req.body?.marks;
  if (!examId || !Array.isArray(marks) || marks.length > 1000) {
    return res.status(400).json({ error: 'Choose a valid examination and provide up to 1000 marks' });
  }
  const cleanMarks = [];
  const studentIds = new Set();
  for (const item of marks) {
    const studentId = parseId(item?.student_id);
    const isAbsent = item?.is_absent === true;
    const score = item?.score === null || item?.score === '' || item?.score === undefined ? null : Number(item.score);
    if (!studentId || studentIds.has(studentId)) return res.status(400).json({ error: 'Marks must have unique, valid student ids' });
    if (!isAbsent && (!Number.isFinite(score) || score < 0)) return res.status(400).json({ error: 'Enter a non-negative mark or record the student as absent' });
    studentIds.add(studentId);
    cleanMarks.push({ studentId, score: isAbsent ? null : score, isAbsent });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await getExam(client, examId);
    if (!exam) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination not found' });
    }
    if (!await examAccess(client, req.user, exam)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this class subject' });
    }
    if (exam.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Marks can only be edited while the examination is open' });
    }
    const eligible = await client.query(
      `SELECT id FROM students
       WHERE is_active = TRUE AND (
         UPPER(TRIM(department)) = UPPER(TRIM($1))
         OR (UPPER(TRIM($1)) IN ('SWD', 'SOD') AND UPPER(TRIM(department)) IN ('SWD', 'SOD'))
       )
         AND REGEXP_REPLACE(UPPER(TRIM(class_level)), '[^A-Z0-9]', '', 'g')
             = REGEXP_REPLACE(UPPER(TRIM($2)), '[^A-Z0-9]', '', 'g')`,
      [exam.program_code, exam.level]
    );
    const eligibleIds = new Set(eligible.rows.map((row) => Number(row.id)));
    if (cleanMarks.some((mark) => !eligibleIds.has(mark.studentId))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A student does not belong to this active class' });
    }
    if (cleanMarks.some((mark) => mark.score !== null && mark.score > Number(exam.max_score))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Marks cannot exceed ${exam.max_score}` });
    }
    for (const mark of cleanMarks) {
      const saved = await client.query(
        `INSERT INTO examination_marks (examination_id, student_id, score, is_absent, entered_by, status)
         VALUES ($1, $2, $3, $4, $5, 'draft')
         ON CONFLICT (examination_id, student_id)
         DO UPDATE SET score = EXCLUDED.score, is_absent = EXCLUDED.is_absent,
                       entered_by = EXCLUDED.entered_by, updated_at = CURRENT_TIMESTAMP
         WHERE examination_marks.status = 'draft'
         RETURNING id`,
        [examId, mark.studentId, mark.score, mark.isAbsent, req.user.id]
      );
      if (!saved.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Submitted or approved marks cannot be overwritten; an administrator must reopen the examination' });
      }
    }
    await client.query('COMMIT');
    return res.json({ message: 'Draft marks saved', saved: cleanMarks.length });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Save examination marks');
  } finally {
    client.release();
  }
});

router.post('/exams/:id/marks/import', ...academicAccess, parseMarksUpload, async (req, res) => {
  const examId = parseId(req.params.id);
  if (!examId) return res.status(400).json({ error: 'Choose a valid examination id' });
  if (!req.file) return res.status(400).json({ error: 'Choose a CSV or XLSX marks file' });
  let records;
  try {
    records = await readMarksWorkbook(req.file);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Marks file could not be parsed' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await getExam(client, examId);
    if (!exam) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination not found' });
    }
    if (!await examAccess(client, req.user, exam)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this class subject' });
    }
    if (exam.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Marks can only be imported while the examination is open' });
    }
    const roster = await client.query(
      `SELECT id, student_code
       FROM students
       WHERE is_active = TRUE AND (
         UPPER(TRIM(department)) = UPPER(TRIM($1))
         OR (UPPER(TRIM($1)) IN ('SWD', 'SOD') AND UPPER(TRIM(department)) IN ('SWD', 'SOD'))
       )
         AND REGEXP_REPLACE(UPPER(TRIM(class_level)), '[^A-Z0-9]', '', 'g')
             = REGEXP_REPLACE(UPPER(TRIM($2)), '[^A-Z0-9]', '', 'g')`,
      [exam.program_code, exam.level]
    );
    const studentsByCode = new Map(roster.rows.map((student) => [String(student.student_code).trim().toUpperCase(), Number(student.id)]));
    const seenStudents = new Set();
    const cleanMarks = [];
    for (const [index, record] of records.entries()) {
      const code = asText(record.student_code).toUpperCase();
      const studentId = studentsByCode.get(code);
      const absent = ['true', '1', 'yes', 'absent'].includes(asText(record.is_absent).toLowerCase());
      const score = absent ? null : Number(record.score);
      if (!studentId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Student code on file row ${index + 2} is not in this active class` });
      }
      if (seenStudents.has(studentId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Student code ${code} appears more than once in the marks file` });
      }
      if (!absent && (
        record.score === null
        || record.score === undefined
        || asText(record.score) === ''
        || !Number.isFinite(score)
        || score < 0
        || score > Number(exam.max_score)
      )) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Enter a mark from 0 to ${exam.max_score}, or mark the student absent (file row ${index + 2})` });
      }
      seenStudents.add(studentId);
      cleanMarks.push({ studentId, score, absent });
    }
    for (const mark of cleanMarks) {
      const saved = await client.query(
        `INSERT INTO examination_marks (examination_id, student_id, score, is_absent, entered_by, status)
         VALUES ($1, $2, $3, $4, $5, 'draft')
         ON CONFLICT (examination_id, student_id)
         DO UPDATE SET score = EXCLUDED.score, is_absent = EXCLUDED.is_absent,
                       entered_by = EXCLUDED.entered_by, updated_at = CURRENT_TIMESTAMP
         WHERE examination_marks.status = 'draft'
         RETURNING id`,
        [examId, mark.studentId, mark.score, mark.absent, req.user.id]
      );
      if (!saved.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Submitted or approved marks cannot be overwritten; an administrator must reopen the examination' });
      }
    }
    await client.query('COMMIT');
    return res.json({ message: 'Marks imported as drafts', imported: cleanMarks.length });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Import examination marks');
  } finally {
    client.release();
  }
});

router.post('/exams/:id/submit', ...academicAccess, async (req, res) => {
  const examId = parseId(req.params.id);
  if (!examId) return res.status(400).json({ error: 'Choose a valid examination id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await getExam(client, examId);
    if (!exam) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination not found' });
    }
    if (!await examAccess(client, req.user, exam)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this class subject' });
    }
    if (exam.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This examination is not open for submission' });
    }
    const eligibility = await client.query(
      `SELECT COUNT(*)::int AS total FROM students
       WHERE is_active = TRUE AND (
         UPPER(TRIM(department)) = UPPER(TRIM($1))
         OR (UPPER(TRIM($1)) IN ('SWD', 'SOD') AND UPPER(TRIM(department)) IN ('SWD', 'SOD'))
       )
         AND REGEXP_REPLACE(UPPER(TRIM(class_level)), '[^A-Z0-9]', '', 'g')
             = REGEXP_REPLACE(UPPER(TRIM($2)), '[^A-Z0-9]', '', 'g')`,
      [exam.program_code, exam.level]
    );
    const marks = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_absent OR score IS NOT NULL)::int AS complete,
              COUNT(*) FILTER (WHERE status <> 'draft')::int AS locked
       FROM examination_marks WHERE examination_id = $1`,
      [examId]
    );
    const expected = Number(eligibility.rows[0].total);
    const recorded = Number(marks.rows[0].total);
    if (!expected || expected !== recorded || Number(marks.rows[0].complete) !== expected) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Record marks or absence for all ${expected} active students before submission` });
    }
    if (Number(marks.rows[0].locked)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This examination contains marks that are already submitted' });
    }
    await client.query("UPDATE examination_marks SET status = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE examination_id = $1", [examId]);
    await client.query("UPDATE examinations SET status = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [examId]);
    await client.query('COMMIT');
    return res.json({ message: 'Marks submitted for approval' });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Submit examination marks');
  } finally {
    client.release();
  }
});

const transitionMarks = async (req, res, nextStatus, allowedStatus, adminOnlyAction = false) => {
  const examId = parseId(req.params.id);
  if (!examId) return res.status(400).json({ error: 'Choose a valid examination id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exam = await getExam(client, examId);
    if (!exam) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination not found' });
    }
    if (adminOnlyAction && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Administrator access is required' });
    }
    if (!adminOnlyAction && !await examAccess(client, req.user, exam)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this class subject' });
    }
    const update = await client.query(
      `UPDATE examination_marks
       SET status = $1,
           approved_by = CASE WHEN $1 = 'approved' THEN $2 ELSE approved_by END,
           approved_at = CASE WHEN $1 = 'approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,
           published_at = CASE WHEN $1 = 'published' THEN CURRENT_TIMESTAMP ELSE published_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE examination_id = $3 AND status = $4
       RETURNING id`,
      [nextStatus, req.user.id, examId, allowedStatus]
    );
    if (!update.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `No marks are in ${allowedStatus} state for this action` });
    }
    const examStatus = await client.query(
      'UPDATE examinations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
      [nextStatus, examId]
    );
    if (!examStatus.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Examination not found' });
    }
    await client.query('COMMIT');
    return res.json({ message: `Marks ${nextStatus}` });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, `${nextStatus} examination marks`);
  } finally {
    client.release();
  }
};

router.post('/exams/:id/approve', ...adminOnly, (req, res) => transitionMarks(req, res, 'approved', 'submitted', true));
router.post('/exams/:id/publish', ...adminOnly, (req, res) => transitionMarks(req, res, 'published', 'approved', true));

router.post('/exams/:id/reopen', ...adminOnly, async (req, res) => {
  const examId = parseId(req.params.id);
  if (!examId) return res.status(400).json({ error: 'Choose a valid examination id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reopened = await client.query(
      `UPDATE examinations SET status = 'open', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('submitted', 'approved', 'published') RETURNING id`,
      [examId]
    );
    if (!reopened.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only submitted, approved or published examinations can be reopened' });
    }
    await client.query(
      `UPDATE examination_marks SET status = 'draft', approved_by = NULL, approved_at = NULL,
       published_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE examination_id = $1`,
      [examId]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Examination reopened for corrections' });
  } catch (error) {
    await client.query('ROLLBACK');
    return handleDatabaseError(res, error, 'Reopen examination');
  } finally {
    client.release();
  }
});

router.get('/results', ...academicAccess, async (req, res) => {
  const classSubjectId = parseId(req.query.class_subject_id);
  const termId = parseId(req.query.term_id);
  if (!classSubjectId || !termId) return res.status(400).json({ error: 'Choose a class subject and term' });
  const client = await pool.connect();
  try {
    const classSubject = await client.query(
      `SELECT cs.id, cs.academic_year_id, c.name AS class_name, c.level,
              p.code AS program_code, p.name AS program_name, s.name AS subject_name,
              ay.name AS academic_year
       FROM class_subjects cs
       JOIN academic_classes c ON c.id = cs.class_id
       JOIN academic_programs p ON p.id = c.program_id
       JOIN academic_subjects s ON s.id = cs.subject_id
       JOIN academic_years ay ON ay.id = cs.academic_year_id
       WHERE cs.id = $1`,
      [classSubjectId]
    );
    if (!classSubject.rowCount) return res.status(404).json({ error: 'Class subject not found' });
    if (!await teacherHasAccess(client, req.user, classSubjectId)) {
      return res.status(403).json({ error: 'You are not assigned to this class subject' });
    }
    const term = await client.query('SELECT academic_year_id FROM academic_terms WHERE id = $1', [termId]);
    if (!term.rowCount || Number(term.rows[0].academic_year_id) !== Number(classSubject.rows[0].academic_year_id)) {
      return res.status(400).json({ error: 'Choose a term in the class subject academic year' });
    }
    const result = await client.query(
      `WITH class_students AS (
         SELECT s.id AS student_id, s.student_code, s.first_name, s.last_name
         FROM students s
         WHERE s.is_active = TRUE
           AND (
             UPPER(TRIM(s.department)) = UPPER(TRIM($1))
             OR (UPPER(TRIM($1)) IN ('SWD', 'SOD') AND UPPER(TRIM(s.department)) IN ('SWD', 'SOD'))
           )
           AND REGEXP_REPLACE(UPPER(TRIM(s.class_level)), '[^A-Z0-9]', '', 'g')
               = REGEXP_REPLACE(UPPER(TRIM($2)), '[^A-Z0-9]', '', 'g')
       ),
       exam_counts AS (
         SELECT COUNT(*)::int AS total FROM examinations
         WHERE class_subject_id = $3 AND term_id = $4
       ),
       student_totals AS (
         SELECT cs.student_id, cs.student_code, cs.first_name, cs.last_name,
                COUNT(m.id)::int AS recorded_exams,
                COUNT(m.id) FILTER (WHERE m.status = 'published')::int AS published_exams,
                COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND NOT m.is_absent AND m.score IS NOT NULL
                  THEN (m.score / NULLIF(e.max_score, 0)) * e.weight ELSE 0 END), 0) AS weighted_marks,
                COALESCE(SUM(e.weight), 0) AS total_weight
         FROM class_students cs
         LEFT JOIN examinations e ON e.class_subject_id = $3 AND e.term_id = $4
         LEFT JOIN examination_marks m ON m.examination_id = e.id AND m.student_id = cs.student_id
         GROUP BY cs.student_id, cs.student_code, cs.first_name, cs.last_name
       ),
       percentages AS (
         SELECT *,
                CASE WHEN total_weight > 0 AND recorded_exams = (SELECT total FROM exam_counts)
                  THEN weighted_marks / total_weight * 100 ELSE NULL END AS percentage,
                (recorded_exams = (SELECT total FROM exam_counts)
                  AND (SELECT total FROM exam_counts) > 0) AS is_complete,
                (recorded_exams = (SELECT total FROM exam_counts)
                  AND published_exams = (SELECT total FROM exam_counts)
                  AND (SELECT total FROM exam_counts) > 0) AS is_published
         FROM student_totals
       )
       SELECT p.*,
              $5::text AS class_name,
              $6::text AS program_name,
              $7::text AS subject_name,
              $8::text AS academic_year,
              grade_band.grade,
              grade_band.remark AS grade_remark,
              grade_band.is_passing AS passed,
              CASE WHEN percentage IS NOT NULL AND is_complete THEN RANK() OVER (
                ORDER BY CASE WHEN is_complete THEN percentage END DESC NULLS LAST
              ) ELSE NULL END AS position
       FROM percentages p
       LEFT JOIN LATERAL (
         SELECT grade, remark, is_passing
         FROM grade_scale
         WHERE p.percentage BETWEEN minimum_percentage AND maximum_percentage
         ORDER BY minimum_percentage DESC, sort_order
         LIMIT 1
       ) grade_band ON TRUE
       ORDER BY percentage DESC NULLS LAST, last_name, first_name`,
      [
        classSubject.rows[0].program_code,
        classSubject.rows[0].level,
        classSubjectId,
        termId,
        classSubject.rows[0].class_name,
        classSubject.rows[0].program_name,
        classSubject.rows[0].subject_name,
        classSubject.rows[0].academic_year,
      ]
    );
    return res.json(result.rows);
  } catch (error) {
    return handleDatabaseError(res, error, 'Calculate academic results');
  } finally {
    client.release();
  }
});

module.exports = router;
