const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const programCodes = new Set(['SWD', 'NIT', 'CSA', 'ACC', 'FAD']);
const levelsByProgram = {
  SWD: ['L3SWD', 'L4SWDA', 'L4SWDB', 'L5SWD', 'L3', 'L4', 'L5'],
  NIT: ['L3NIT', 'L4NITA', 'L4NITB', 'L5NIT', 'L3', 'L4', 'L5'],
  CSA: ['L3CSA', 'L4CSA', 'L5CSA', 'L3', 'L4', 'L5'],
  ACC: ['S4ACC', 'S5ACC', 'S6ACC', 'S4', 'S5', 'S6'],
  FAD: ['L3FAD', 'L4FAD', 'L5FAD', 'L3', 'L4', 'L5'],
};

const baseLevel = (value) => String(value || '').trim().toUpperCase().replace(/^LEVEL\s*/, 'L').match(/^(L[345]|S[456])/)?.[0] || '';
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many result searches. Please try again later.' },
});

const resultSelect = `
  SELECT result_rows.*,
    RANK() OVER (
      PARTITION BY program_code, academic_year, term, department, class_level
      ORDER BY total_marks DESC
    ) AS position
  FROM (
    SELECT
      r.id,
      r.student_id,
      CONCAT_WS(' ', s.first_name, s.last_name) AS student_name,
      s.student_code,
      s.class_level,
      s.department,
      r.program_code,
      r.academic_year,
      r.term,
      r.remarks,
      r.is_published,
      r.created_at,
      r.updated_at,
      COALESCE(SUM(subject.score), 0) AS total_marks,
      COALESCE(SUM(subject.max_score), 0) AS maximum_marks,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', subject.id,
            'subject_name', subject.subject_name,
            'score', subject.score,
            'max_score', subject.max_score
          ) ORDER BY subject.id
        ) FILTER (WHERE subject.id IS NOT NULL),
        '[]'::json
      ) AS subjects
    FROM student_results r
    JOIN students s ON s.id = r.student_id
    LEFT JOIN student_result_subjects subject ON subject.result_id = r.id
    GROUP BY r.id, s.id
  ) AS result_rows
`;

const validateResult = (body) => {
  const studentId = Number(body?.student_id);
  const programCode = String(body?.program_code || '').trim().toUpperCase();
  const academicYear = String(body?.academic_year || '').trim();
  const term = String(body?.term || '').trim();
  const remarks = String(body?.remarks || '').trim();
  const subjects = body?.subjects;

  if (!Number.isInteger(studentId) || studentId < 1) {
    return { error: 'Choose a valid student' };
  }
  if (!programCodes.has(programCode)) {
    return { error: 'Choose a valid student program' };
  }
  if (!/^\d{4}(?:-\d{4})?$/.test(academicYear)) {
    return { error: 'Academic year must be a year such as 2026 or 2026-2027' };
  }
  if (!term || term.length > 30) {
    return { error: 'Term is required and must be 30 characters or fewer' };
  }
  if (remarks.length > 2000) {
    return { error: 'Remarks must be 2000 characters or fewer' };
  }
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 30) {
    return { error: 'Enter between 1 and 30 subject marks' };
  }

  const cleanSubjects = [];
  const subjectNames = new Set();
  for (const subject of subjects) {
    const subjectName = String(subject?.subject_name || '').trim();
    const score = Number(subject?.score);
    const maxScore = Number(subject?.max_score);
    if (!subjectName || subjectName.length > 100) {
      return { error: 'Each subject needs a name of 1 to 100 characters' };
    }
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || score < 0 || maxScore <= 0 || score > maxScore) {
      return { error: `Enter valid marks for ${subjectName}` };
    }
    const normalizedName = subjectName.toLocaleLowerCase();
    if (subjectNames.has(normalizedName)) {
      return { error: `Subject "${subjectName}" is listed more than once` };
    }
    subjectNames.add(normalizedName);
    cleanSubjects.push({ subjectName, score, maxScore });
  }

  return {
    value: {
      studentId,
      programCode,
      academicYear,
      term,
      remarks: remarks || null,
      isPublished: body?.is_published === true,
      subjects: cleanSubjects,
    },
  };
};

router.post('/lookup', lookupLimiter, async (req, res) => {
  const studentName = String(req.body?.student_name || '').trim();
  const programCode = String(req.body?.program_code || '').trim().toUpperCase();
  const classLevel = String(req.body?.class_level || '').trim().toUpperCase();

  if (studentName.length < 3 || studentName.length > 160) {
    return res.status(400).json({ error: 'Enter the student’s full name (3 to 160 characters)' });
  }
  if (!programCodes.has(programCode)) {
    return res.status(400).json({ error: 'Choose a valid student program' });
  }
  if (!levelsByProgram[programCode]?.includes(classLevel)) {
    return res.status(400).json({ error: 'Choose a valid level or section for this program' });
  }

  try {
    const results = await pool.query(
      `SELECT * FROM (${resultSelect}) AS ranked_results
       WHERE LOWER(TRIM(student_name)) = LOWER(TRIM($1))
         AND program_code = $2
         AND (
           UPPER(TRIM(class_level)) = $3
           OR SUBSTRING(REGEXP_REPLACE(UPPER(TRIM(class_level)), '^LEVEL[[:space:]]*', 'L') FROM '^(L[345]|S[456])') = $4
         )
         AND is_published = TRUE
         AND student_id IN (SELECT id FROM students WHERE is_active = TRUE)
       ORDER BY academic_year DESC, term DESC, updated_at DESC
       LIMIT 50`,
      [studentName, programCode, classLevel, baseLevel(classLevel)]
    );
    const publicResults = results.rows.map(({ id, student_name, program_code, class_level, academic_year, term, remarks, subjects, total_marks, maximum_marks, position }) => ({
      id,
      student_name,
      program_code,
      class_level,
      academic_year,
      term,
      remarks,
      subjects,
      total_marks,
      maximum_marks,
      position,
    }));
    return res.json({ results: publicResults });
  } catch (err) {
    console.error('[Results] Public lookup failed:', err);
    return res.status(500).json({ error: 'Unable to retrieve results right now' });
  }
});

router.get('/', ...adminOnly, async (req, res) => {
  try {
    const results = await pool.query(
      `SELECT * FROM (${resultSelect}) AS ranked_results
       ORDER BY updated_at DESC
       LIMIT 500`
    );
    return res.json(results.rows);
  } catch (err) {
    console.error('[Results] Admin list failed:', err);
    return res.status(500).json({ error: 'Unable to load student results' });
  }
});

router.post('/', ...adminOnly, async (req, res) => {
  const validation = validateResult(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  const { studentId, programCode, academicYear, term, remarks, isPublished, subjects } = validation.value;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const student = await client.query(
      'SELECT id, department FROM students WHERE id = $1 AND is_active = TRUE',
      [studentId]
    );
    if (student.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active student not found' });
    }
    const studentDepartment = String(student.rows[0].department || '').trim().toUpperCase();
    const allowedDepartments = programCode === 'SWD' ? ['SWD', 'SOD'] : [programCode];
    if (!allowedDepartments.includes(studentDepartment)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The selected student does not belong to this program' });
    }

    const saved = await client.query(
      `INSERT INTO student_results
         (student_id, program_code, academic_year, term, remarks, is_published, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (student_id, program_code, academic_year, term)
       DO UPDATE SET
         remarks = EXCLUDED.remarks,
         is_published = EXCLUDED.is_published,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [studentId, programCode, academicYear, term, remarks, isPublished, req.user.id]
    );
    const resultId = saved.rows[0].id;

    await client.query('DELETE FROM student_result_subjects WHERE result_id = $1', [resultId]);
    for (const subject of subjects) {
      await client.query(
        `INSERT INTO student_result_subjects (result_id, subject_name, score, max_score)
         VALUES ($1, $2, $3, $4)`,
        [resultId, subject.subjectName, subject.score, subject.maxScore]
      );
    }

    const result = await client.query(
      `SELECT * FROM (${resultSelect}) AS ranked_results
       WHERE id = $1`,
      [resultId]
    );
    await client.query('COMMIT');
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Results] Save failed:', err);
    return res.status(500).json({ error: 'Unable to save student results' });
  } finally {
    client.release();
  }
});

module.exports = router;
