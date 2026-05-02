const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const CONVERSATIONS_FILE = path.join(__dirname, '..', 'conversations.json');
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const FIXED_SLOTS = new Set(['ASSEMBLY', 'BREAK', 'LUNCH']);

// ─── Conversation persistence ────────────────────────────────────────────────

function loadConversations() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading conversations:', e);
  }
  return {};
}

function saveConversations(conversations) {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving conversations:', e);
  }
}

// ─── Build timetable context for AI ──────────────────────────────────────────

function timeSortKey(t) {
  const m = t.match(/(\d+):(\d+)/);
  if (m) {
    let h = parseInt(m[1]), mins = parseInt(m[2]);
    if (h >= 1 && h <= 6) h += 12;
    return h * 60 + mins;
  }
  return 0;
}

function buildTeacherSchedules(classesData, teacherNames) {
  const teachers = {};

  for (const [className, schedule] of Object.entries(classesData)) {
    for (const [ts, dayData] of Object.entries(schedule)) {
      for (const [day, cell] of Object.entries(dayData)) {
        if (!cell || cell === '--') continue;
        const cu = cell.toUpperCase().trim();
        if (FIXED_SLOTS.has(cu) || cu === 'CPD' || cu === 'NONE' || cu === '') continue;
        const m = cell.match(/\((\d+)\)/);
        if (m) {
          const code = m[1];
          const subject = cell.replace(/\s*\(\d+\)\s*/, '').trim();
          if (!teachers[code]) {
            teachers[code] = { subjects: new Set(), classes: new Set(), schedule: {} };
          }
          teachers[code].subjects.add(subject);
          teachers[code].classes.add(className);
          if (!teachers[code].schedule[ts]) teachers[code].schedule[ts] = {};
          teachers[code].schedule[ts][day] = `${subject} (${className})`;
        }
      }
    }
  }

  const result = {};
  for (const [code, data] of Object.entries(teachers)) {
    const name = teacherNames[code] || `Teacher ${code}`;
    result[code] = {
      name,
      code,
      subjects: [...data.subjects].sort(),
      classes: [...data.classes].sort(),
      schedule: data.schedule
    };
  }
  return result;
}

async function buildContext() {
  // Fetch all published timetables from database
  const timetablesResult = await pool.query(
    `SELECT class_name, schedule_data FROM timetables WHERE status = 'published' ORDER BY class_name`
  );

  const classesData = {};
  for (const row of timetablesResult.rows) {
    classesData[row.class_name] = row.schedule_data;
  }

  // Fetch teacher names from teacher_timetables
  const teacherResult = await pool.query(
    `SELECT DISTINCT teacher_code, teacher_name FROM teacher_timetables`
  );
  const teacherNames = {};
  for (const row of teacherResult.rows) {
    teacherNames[row.teacher_code] = row.teacher_name;
  }

  const now = new Date();
  const currentTime = now.toISOString().replace('T', ' ').substring(0, 19);
  const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' });

  let context = `You are a school timetable assistant. Here is the current timetable data (sorted from morning assembly to evening):\n\n`;

  for (const [cn, schedule] of Object.entries(classesData)) {
    context += `## Class: ${cn}\n`;
    const sortedTs = Object.keys(schedule).sort((a, b) => timeSortKey(a) - timeSortKey(b));
    for (const ts of sortedTs) {
      const dd = schedule[ts];
      context += `  ${ts}: ` + Object.entries(dd).map(([d, v]) => `${d}=${v}`).join(', ') + '\n';
    }
  }

  const teachers = buildTeacherSchedules(classesData, teacherNames);
  context += '\n## Teachers:\n';
  for (const [code, t] of Object.entries(teachers)) {
    context += `  Code ${code}: ${t.name} - Classes: ${t.classes.join(', ')} - Subjects: ${t.subjects.join(', ')}\n`;
  }
  context += `\nTeacher code mapping: ${JSON.stringify(teacherNames)}\n`;
  context += '\nFormat: SUBJECT(CODE) means teacher with that code teaches that subject.\nWhen asked to create a teacher timetable, format it as a markdown table with Time slots as rows and Monday-Friday as columns.\n';

  return { context, currentTime, currentDay };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Chat endpoint
router.post('/', async (req, res) => {
  try {
    const { message, history = [], conversation_id } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { context, currentTime, currentDay } = await buildContext();

    // Check if user is asking about time
    let userMessage = message;
    const timeKeywords = ['time', 'clock', 'what time', 'current time', 'now', 'today'];
    if (timeKeywords.some(kw => message.toLowerCase().includes(kw))) {
      userMessage = `[Current time: ${currentTime} (${currentDay})] ${message}`;
    }

    const messages = [
      { role: 'system', content: context },
      ...history.slice(-10),
      { role: 'user', content: userMessage }
    ];

    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || 'deepseek-v3.1:671b-cloud';

    const ollamaResp = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaModel, messages, stream: false }),
      signal: AbortSignal.timeout(120000)
    });

    if (ollamaResp.ok) {
      const data = await ollamaResp.json();
      const responseText = data.message?.content || 'No response';

      // Save to conversation if provided
      if (conversation_id) {
        const conversations = loadConversations();
        if (conversations[conversation_id]) {
          conversations[conversation_id].messages.push({ role: 'user', content: message });
          conversations[conversation_id].messages.push({ role: 'assistant', content: responseText });
          conversations[conversation_id].updated_at = new Date().toISOString();
          // Update title based on first user message
          if (conversations[conversation_id].messages.length <= 2) {
            conversations[conversation_id].title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
          }
          saveConversations(conversations);
        }
      }

      return res.json({ response: responseText });
    }

    return res.json({ response: `Ollama error: ${ollamaResp.status}` });
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
      return res.json({ response: 'Request timed out. The AI model took too long to respond.' });
    }
    if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      return res.json({ response: 'Cannot connect to Ollama. Make sure Ollama is running (ollama serve) and the model is available.' });
    }
    console.error('Chat error:', err);
    return res.json({ response: `Error: ${err.message}` });
  }
});

// List conversations
router.get('/conversations', (req, res) => {
  const conversations = loadConversations();
  const sorted = Object.values(conversations).sort((a, b) =>
    new Date(b.updated_at) - new Date(a.updated_at)
  );
  res.json(sorted);
});

// Create new conversation
router.post('/conversations', (req, res) => {
  const conversations = loadConversations();
  const id = uuidv4();
  conversations[id] = {
    id,
    title: 'New Chat',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: []
  };
  saveConversations(conversations);
  res.json(conversations[id]);
});

// Get single conversation
router.get('/conversations/:id', (req, res) => {
  const conversations = loadConversations();
  const conv = conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conv);
});

// Delete conversation
router.delete('/conversations/:id', (req, res) => {
  const conversations = loadConversations();
  if (!conversations[req.params.id]) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  delete conversations[req.params.id];
  saveConversations(conversations);
  res.json({ success: true });
});

// Get current time
router.get('/time', (req, res) => {
  res.json({ time: new Date().toISOString().replace('T', ' ').substring(0, 19) });
});

module.exports = router;
