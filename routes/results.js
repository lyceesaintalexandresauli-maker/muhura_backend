const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const programCodes = new Set(['SWD', 'NIT', 'CSA', 'ACC', 'FAD']);
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many result searches. Please try again later.' },
});

const resultSelect = `
  SELECT
    r.id,
    r.student_id,
    CONCAT_WS(' ', s.first_name, s.last_name) AS student_name,
    s.student_code,
    r.program_code,
    r.academic_year,
    r.term,
    r.remarks,
    r.is_published,
    r.created_at,
    r.updated_at,
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

  if (studentName.length < 3 || studentName.length > 160) {
    return res.status(400).json({ error: 'Enter the student’s full name (3 to 160 characters)' });
  }
  if (!programCodes.has(programCode)) {
    return res.status(400).json({ error: 'Choose a valid student program' });
  }

  try {
    const results = await pool.query(
      `${resultSelect}
       WHERE LOWER(TRIM(CONCAT_WS(' ', s.first_name, s.last_name))) = LOWER(TRIM($1))
         AND r.program_code = $2
         AND r.is_published = TRUE
         AND s.is_active = TRUE
       GROUP BY r.id, s.id
       ORDER BY r.academic_year DESC, r.term DESC, r.updated_at DESC
       LIMIT 50`,
      [studentName, programCode]
    );
    const publicResults = results.rows.map(({ id, student_name, program_code, academic_year, term, remarks, subjects }) => ({
      id,
      student_name,
      program_code,
      academic_year,
      term,
      remarks,
      subjects,
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
      `${resultSelect}
       GROUP BY r.id, s.id
       ORDER BY r.updated_at DESC
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
      'SELECT id FROM students WHERE id = $1 AND is_active = TRUE',
      [studentId]
    );
    if (student.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active student not found' });
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
      `${resultSelect}
       WHERE r.id = $1
       GROUP BY r.id, s.id`,
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
