const crypto = require('crypto');
const express = require('express');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const MAX_ROWS = 500;
const MAX_SUBJECTS = 30;
const classLevelsByProgram = {
  SWD: ['L3SWD', 'L4SWDA', 'L4SWDB', 'L5SWD', 'L3', 'L4', 'L5'],
  NIT: ['L3NIT', 'L4NITA', 'L4NITB', 'L5NIT', 'L3', 'L4', 'L5'],
  CSA: ['L3CSA', 'L4CSA', 'L5CSA', 'L3', 'L4', 'L5'],
  ACC: ['S4ACC', 'S5ACC', 'S6ACC', 'S4', 'S5', 'S6'],
  FAD: ['L3FAD', 'L4FAD', 'L5FAD', 'L3', 'L4', 'L5'],
};

const cleanText = (value, maxLength = 160) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
const normalizeLevel = (value) => cleanText(value).toUpperCase().replace(/^LEVEL\s*/, 'L').replace(/[^A-Z0-9]/g, '');
const normalizeName = (value) => cleanText(value, 160).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const validateClass = (value) => {
  const classLevel = cleanText(value, 30).toUpperCase();
  const normalized = normalizeLevel(classLevel);
  for (const [department, levels] of Object.entries(classLevelsByProgram)) {
    if (levels.some((level) => normalizeLevel(level) === normalized)) {
      const canonicalLevel = levels.find((level) => normalizeLevel(level) === normalized);
      return { department, classLevel: canonicalLevel };
    }
  }
  return null;
};

const getAiUrl = () => {
  const configured = String(process.env.AI_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configured || configured.includes('your-ai-endpoint.example')) return null;
  return configured.endsWith('/chat/completions') ? configured : `${configured}/chat/completions`;
};

router.post('/map-headers', ...adminOnly, async (req, res) => {
  const headers = req.body?.headers;
  if (!Array.isArray(headers) || headers.length < 2 || headers.length > 80) {
    return res.status(400).json({ error: 'Provide between 2 and 80 spreadsheet column headings.' });
  }
  const safeHeaders = headers.map((header) => cleanText(header, 120));
  if (safeHeaders.some((header) => !header) || safeHeaders.join('').length > 5000) {
    return res.status(400).json({ error: 'Column headings must be non-empty and under 5,000 characters total.' });
  }

  const aiUrl = getAiUrl();
  const apiKey = String(process.env.AI_API_KEY || '').trim();
  const model = String(process.env.AI_MODEL || '').trim();
  if (!aiUrl || !apiKey || !model || apiKey === 'replace-with-your-secret-key' || model === 'replace-with-your-model-name') {
    return res.status(503).json({ error: 'AI column suggestions are not configured. You can still map columns manually and import the sheet.' });
  }

  try {
    const response = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Map spreadsheet column headings to student result fields. You receive headings only, never student data. Return only JSON with keys student_code, full_name, first_name, last_name, class_level (each an integer column index or null), and subject_columns (an array of integer column indexes). Do not classify metadata columns as subjects. Do not invent column indexes.',
          },
          { role: 'user', content: JSON.stringify(safeHeaders) },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[Result import AI] Provider error:', response.status, body?.error?.message || body?.message || 'unknown error');
      return res.status(502).json({ error: 'The AI column suggestion service could not process the headings. Map them manually or try again.' });
    }

    let content = body?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) content = content.map((part) => part?.text || '').join('');
    if (typeof content !== 'string') throw new Error('AI response did not contain text');
    const jsonText = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const suggestion = JSON.parse(jsonText);
    const validIndex = (index) => Number.isInteger(index) && index >= 0 && index < safeHeaders.length;
    const mapping = {};
    for (const key of ['student_code', 'full_name', 'first_name', 'last_name', 'class_level']) {
      mapping[key] = validIndex(suggestion[key]) ? suggestion[key] : null;
    }
    mapping.subject_columns = Array.isArray(suggestion.subject_columns)
      ? [...new Set(suggestion.subject_columns.filter(validIndex))].filter((index) => !Object.values(mapping).includes(index))
      : [];

    return res.json({ mapping });
  } catch (error) {
    console.error('[Result import AI] Request failed:', error.message);
    return res.status(502).json({ error: 'Could not get column suggestions from AI. Map the columns manually or try again.' });
  }
});

router.post('/', ...adminOnly, async (req, res) => {
  const academicYear = cleanText(req.body?.academic_year, 9);
  const term = cleanText(req.body?.term, 30);
  const records = req.body?.records;
  if (!/^\d{4}(?:-\d{4})?$/.test(academicYear)) {
    return res.status(400).json({ error: 'Academic year must look like 2026 or 2026-2027.' });
  }
  if (!['Term 1', 'Term 2', 'Term 3'].includes(term)) {
    return res.status(400).json({ error: 'Choose Term 1, Term 2, or Term 3.' });
  }
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_ROWS) {
    return res.status(400).json({ error: `Import between 1 and ${MAX_ROWS} student rows at a time.` });
  }

  const validated = [];
  const identities = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const row = records[index] || {};
    const rowNumber = Number.isInteger(row.row_number) ? row.row_number : index + 2;
    const firstName = cleanText(row.first_name, 80);
    const lastName = cleanText(row.last_name, 80);
    const studentCode = cleanText(row.student_code, 50);
    const requestedLevel = cleanText(row.class_level, 30);
    const classInfo = validateClass(requestedLevel);
    const subjects = row.subjects;

    if (!firstName || !lastName) return res.status(400).json({ error: `Row ${rowNumber}: provide the student's first and last name.` });
    if (!classInfo) return res.status(400).json({ error: `Row ${rowNumber}: choose a valid class/level.` });
    if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > MAX_SUBJECTS) {
      return res.status(400).json({ error: `Row ${rowNumber}: include between 1 and ${MAX_SUBJECTS} subject marks.` });
    }

    const subjectNames = new Set();
    const cleanSubjects = [];
    for (const subject of subjects) {
      const subjectName = cleanText(subject?.subject_name, 100);
      const score = Number(subject?.score);
      const maxScore = Number(subject?.max_score);
      const normalizedSubject = subjectName.toLowerCase();
      if (!subjectName || !Number.isFinite(score) || !Number.isFinite(maxScore) || score < 0 || maxScore <= 0 || score > maxScore) {
        return res.status(400).json({ error: `Row ${rowNumber}: enter a valid score and maximum for ${subjectName || 'each subject'}.` });
      }
      if (subjectNames.has(normalizedSubject)) return res.status(400).json({ error: `Row ${rowNumber}: subject "${subjectName}" appears more than once.` });
      subjectNames.add(normalizedSubject);
      cleanSubjects.push({ subjectName, score, maxScore });
    }

    const identity = studentCode
      ? `code:${studentCode.toLowerCase()}`
      : `name:${normalizeName(`${firstName} ${lastName}`)}|${normalizeLevel(classInfo.classLevel)}`;
    if (identities.has(identity)) return res.status(400).json({ error: `Row ${rowNumber}: this student appears more than once in the sheet. Use a unique student code if names are duplicated.` });
    identities.add(identity);
    validated.push({ rowNumber, firstName, lastName, studentCode, ...classInfo, subjects: cleanSubjects });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let studentsCreated = 0;
    let studentsMatched = 0;
    let resultsSaved = 0;

    for (const row of validated) {
      let studentId = null;
      let department = row.department;
      let classLevel = row.classLevel;

      if (row.studentCode) {
        const existing = await client.query(
          'SELECT id, first_name, last_name, department, class_level FROM students WHERE LOWER(TRIM(student_code)) = LOWER(TRIM($1)) FOR UPDATE',
          [row.studentCode]
        );
        if (existing.rows.length) {
          const student = existing.rows[0];
          const sameName = normalizeName(`${student.first_name} ${student.last_name}`) === normalizeName(`${row.firstName} ${row.lastName}`);
          const sameLevel = normalizeLevel(student.class_level) === normalizeLevel(row.classLevel);
          if (!sameName || !sameLevel) throw new Error(`Row ${row.rowNumber}: student code ${row.studentCode} already belongs to a different student or class.`);
          studentId = student.id;
          department = student.department;
          classLevel = student.class_level;
        }
      } else {
        const matches = await client.query(
          `SELECT id, student_code, first_name, last_name, department, class_level
           FROM students
           WHERE LOWER(TRIM(first_name)) = LOWER(TRIM($1))
             AND LOWER(TRIM(last_name)) = LOWER(TRIM($2))
             AND REGEXP_REPLACE(UPPER(TRIM(class_level)), '[^A-Z0-9]', '', 'g') = $3
             AND is_active = TRUE
           FOR UPDATE`,
          [row.firstName, row.lastName, normalizeLevel(row.classLevel)]
        );
        if (matches.rows.length > 1) throw new Error(`Row ${row.rowNumber}: more than one existing student has this name and class. Add the correct student code to the sheet.`);
        if (matches.rows.length === 1) {
          studentId = matches.rows[0].id;
          department = matches.rows[0].department;
          classLevel = matches.rows[0].class_level;
        }
      }

      if (!studentId) {
        const studentCode = row.studentCode || `IMP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        const created = await client.query(
          `INSERT INTO students (student_code, first_name, last_name, class_level, department, is_active)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           RETURNING id`,
          [studentCode, row.firstName, row.lastName, row.classLevel, row.department]
        );
        studentId = created.rows[0].id;
        studentsCreated += 1;
      } else {
        studentsMatched += 1;
      }

      const programCode = department === 'SOD' ? 'SWD' : department;
      const existingResult = await client.query(
        `SELECT id FROM student_results
         WHERE student_id = $1 AND program_code = $2 AND academic_year = $3 AND term = $4
         FOR UPDATE`,
        [studentId, programCode, academicYear, term]
      );
      if (existingResult.rows.length) {
        throw new Error(`Row ${row.rowNumber}: a result already exists for this student, year, and term. Nothing was imported; review the existing result first.`);
      }

      const saved = await client.query(
        `INSERT INTO student_results
           (student_id, program_code, academic_year, term, is_published, created_by, updated_by)
         VALUES ($1, $2, $3, $4, FALSE, $5, $5)
         RETURNING id`,
        [studentId, programCode, academicYear, term, req.user.id]
      );
      for (const subject of row.subjects) {
        await client.query(
          `INSERT INTO student_result_subjects (result_id, subject_name, score, max_score)
           VALUES ($1, $2, $3, $4)`,
          [saved.rows[0].id, subject.subjectName, subject.score, subject.maxScore]
        );
      }
      resultsSaved += 1;
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Import completed. All results were saved as drafts for admin review.',
      students_created: studentsCreated,
      students_matched: studentsMatched,
      results_saved: resultsSaved,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Result import] Failed:', error.message);
    const isKnownImportError = /^Row \d+:/.test(error.message);
    return res.status(isKnownImportError ? 400 : 500).json({ error: isKnownImportError ? error.message : 'Unable to import the spreadsheet. No records were saved.' });
  } finally {
    client.release();
  }
});

module.exports = router;
