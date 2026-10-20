# School Website Backend

Node.js and PostgreSQL backend for the Lycee Saint Alexandre Sauli de Muhura school website.

## Setup

1. Install Node.js and PostgreSQL.

2. Clone or navigate to the project folder.

3. Install dependencies:
   ```
   npm install
   ```

4. Set up PostgreSQL database:
   - Create a database named `school_db`
   - Run `schema.sql` to create tables, or run any new migration files in `migrations/` against an existing database

5. Configure environment variables:
   - Copy `.env` and update with your database credentials

6. Start the server:
   ```
   npm start
   ```

## Security Notes

- Backend uses PostgreSQL (`pg`) only.
- Helmet security headers, anti-parameter-pollution, request size limits, and rate limiting are enabled.
- Roles: `admin`, `teacher`, `secretary`, `dos` (staff), and `parent`.
- Parents use email/password accounts to look up published results by student name and program.
- Result lookup is available to any signed-in parent account, as requested; it is not restricted to that parent's children.
- 2FA (email OTP) is required for `admin`, `teacher`, and `secretary`.
- Admin has full control of management endpoints (create/update/delete for site resources).
- JWT validation enforces `HS256`, `issuer`, and `audience`.
- Public contact message endpoint is rate-limited.

## API Endpoints

### Content
- `GET /api/content` - Get all content
- `GET /api/content/grouped/all` - Get all content grouped by page/section
- `GET /api/content/:page` - Get content for a page
- `POST /api/content` - Create content
- `PUT /api/content/:id` - Update content
- `DELETE /api/content/:id` - Delete content

### Events
- `GET /api/events` - Get all events
- `POST /api/events` - Create event
- `PUT /api/events/:id` - Update event
- `DELETE /api/events/:id` - Delete event

### Announcements
- `GET /api/announcements` - Get all announcements
- `POST /api/announcements` - Create announcement
- `PUT /api/announcements/:id` - Update announcement
- `DELETE /api/announcements/:id` - Delete announcement

### Staff
- `GET /api/staff` - Get all staff
- `GET /api/staff/department/:dept` - Get staff by department
- `POST /api/staff` - Create staff member
- `PUT /api/staff/:id` - Update staff member
- `DELETE /api/staff/:id` - Delete staff member

### Students (Admin Dashboard)
- `GET /api/students` - Admin gets all students
- `GET /api/students/:id` - Admin gets one student
- `POST /api/students` - Admin creates student
- `PUT /api/students/:id` - Admin updates student
- `DELETE /api/students/:id` - Admin deletes student

### Student Results
- `POST /api/auth/parent/register` - Create a parent account with a name, email, and password (minimum 8 characters)
- `GET /api/results` - Admin lists student results, including drafts
- `POST /api/results` - Admin creates/updates marks and chooses whether to publish the result
- `POST /api/results/lookup` - Signed-in parent searches published results using the student's full name and program (`SWD`, `NIT`, `CSA`, `ACC`, or `FAD`)
- Run `migrations/2026-10-20_student_results.sql` on an existing database before deploying the updated backend. New databases can use `schema.sql`.
- Parent account creation requires backend `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and database connection variables. The service-role key is server-only and must never be set in a frontend environment.

### Departments
- `GET /api/departments` - Get all departments
- `POST /api/departments` - Create department
- `PUT /api/departments/:code` - Update department
- `DELETE /api/departments/:code` - Delete department

### Contact
- `GET /api/contact` - Get contact info
- `POST /api/contact` - Create contact info (admin only)
- `PUT /api/contact/:id` - Update contact info (admin only)
- `DELETE /api/contact/:id` - Delete contact info (admin only)
- `POST /api/contact/messages` - Visitor submits contact message/comment
- `GET /api/contact/messages` - Admin reads all visitor messages
- `GET /api/contact/messages/:id` - Admin reads one message (marks unread -> read)
- `PUT /api/contact/messages/:id/status` - Admin updates status (`unread|read|archived`)
- `DELETE /api/contact/messages/:id` - Admin deletes message

### Authentication
- `POST /api/auth/register` - Register staff user (`admin`/`teacher`/`secretary`, requires `setupKey`)
- `POST /api/auth/login` - Step 1 staff login (password + email OTP challenge)
- `POST /api/auth/2fa/verify` - Step 2 staff login using OTP code
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/me` - Update own profile (`username`, `email`, `full_name`, `phone`, `bio`)
- `PUT /api/auth/me/password` - Update own password
- `POST /api/auth/me/profile-image` - Upload/update own profile image (`multipart/form-data`, field `image`)

### Admin User Management
- `GET /api/users` - Admin lists staff users
- `POST /api/users` - Admin creates staff user
- `PUT /api/users/:id` - Admin updates staff user info/role/status
- `PUT /api/users/:id/password` - Admin resets staff password (forces new 2FA setup)
- `DELETE /api/users/:id` - Admin deletes staff user

### Navigation / Site
- `GET /api/navigation` - Flat navigation list
- `GET /api/navigation/tree` - Nested navigation tree
- `GET /api/site/settings` - Shared site settings
- `GET /api/site/bootstrap?page=<page>` - settings + navigation + optional page content

### File Uploads
- `POST /api/uploads` - Upload file
- `GET /api/uploads` - Get all files (admin only)
- `GET /api/uploads/:id` - Get file metadata (admin only)
- `DELETE /api/uploads/:id` - Delete file (admin only, removes file from disk)

## File Storage

Images, videos, and documents are stored in `uploads/` and served at `/uploads/...`.
Legacy frontend static assets are in `assets/` and served at `/assets/...`.

## Database Schema

See `schema.sql` for the complete database structure.

## Useful SQL Seeds

- `seed_navigation.sql` - Navigation + site settings (old website structure)
- `seed_content_sections.sql` - Sectioned content imported from old HTML pages
- `seed_users.sql` - Demo staff users (`admin`, `teacher`, `secretary`)
