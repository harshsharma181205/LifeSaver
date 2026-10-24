LifeSaver — Blood Donation Management System
LifeSaver is a web-based Blood Donation Management System intended to help coordinate donors, recipients, blood requests, blood-bank/organization information, and related notifications. The project has a React frontend and a Node.js/Express backend connected to a MySQL database.
Project status: The repository contains multiple modules at different stages of implementation. A module being present in the codebase does not automatically mean its end-to-end flow has been tested. See the Testing section before describing a feature as fully verified.

Table of Contents
- Features and Modules
- Technology Stack
- Project Structure
- Requirements
- Setup and Run Locally
- Authentication API
- How Authentication Works
- Testing
- Security Notes
- Troubleshooting
- Contributing
Features and Modules
The codebase includes work related to the following areas:
- Authentication: Login flows for donors, recipients, organizations, and blood banks.
- Donor management: Donor profile and dashboard-related functionality.
- Blood requests: Create and manage blood-request-related information.
- Recipient management: Recipient profile, dashboard, and request-detail functionality.
- Notifications: Notification controller, routes, and service.
- Blood-bank and organization support: Related profile and integration functionality.
- Inventory: Inventory controller and routes, with an inventory test file in the backend.
- Request fulfillment/allocation: Related backend and frontend files exist in the codebase; ownership or current completion should be confirmed with the project team.
Feature availability may depend on database setup, route mounting, environment configuration, and whether the relevant frontend and backend flows have been integrated and tested.
Technology Stack
- Frontend: React, JavaScript, CSS, and Vite-based tooling
- Routing: React Router
- HTTP/API requests: Axios (where used by frontend modules)
- Backend: Node.js and Express.js
- Database: MySQL
- Authentication: JWT-based tokens and password verification using Node.js cryptographic utilities
- Testing: Backend test files are present in the repository; actual pass status depends on running the test suite
Project Structure
The project is organized into frontend/ and backend/ directories. Key folders include:
LifeSaver/
├── backend/
│   ├── controllers/       # Request handlers and business logic
│   ├── routes/            # API route definitions
│   ├── middleware/        # Middleware such as authentication checks
│   ├── services/          # Shared business logic and utilities
│   ├── migrations/        # Database migration/integration scripts
│   └── tests/             # Backend tests
└── frontend/
    └── src/
        ├── components/    # Reusable React components
        ├── context/       # Shared React context
        ├── pages/         # Application pages
        ├── services/      # Frontend API helpers
        ├── styles/        # CSS stylesheets
        └── utils/         # Frontend utilities
Requirements
Install the following before running the application:
- Node.js and npm
- MySQL Server
- Git (optional, for cloning and version control)
Setup and Run Locally
1. Get the project
Clone the repository or open your existing project folder:
git clone https://github.com/harshsharma181205/LifeSaver-Blood-Management-System.git
cd LifeSaver-Blood-Management-System
If you already have the project locally, open the LifeSaver project directory instead of cloning it again.
2. Configure MySQL
1. Start MySQL Server.
2. Create/configure the database required by the project.
3. Confirm that the tables expected by the backend exist.
4. Check backend/db.js and any environment/configuration files it reads to determine the required database host, port, database name, username, and password.
5. Keep database credentials in local environment configuration and do not commit real passwords or secrets.
The exact database name, schema setup commands, and environment-variable names should be taken from the current repository configuration. Do not assume this README creates or migrates the database automatically.
3. Install backend dependencies
Open a terminal in the project root and run:
cd backend
npm install
Start the backend using a script defined in backend/package.json. For example, if the corresponding script exists, use:
npm run dev
or:
npm start
The authentication API examples in this README use http://localhost:5000; confirm the actual backend port in the server configuration.
4. Install frontend dependencies
Open a second terminal from the project root:
cd frontend
npm install
npm run dev
Vite will print the local frontend URL in the terminal, commonly http://localhost:5173. Open the URL shown by your terminal.
5. Check frontend-to-backend connectivity
- Confirm the backend is running before testing API-backed pages.
- Confirm the frontend API base URL points to the running backend.
- If the browser reports a CORS error, check the backend CORS configuration and allowed frontend origin.
- If an API request fails, inspect the browser Network tab and backend terminal output.
Authentication API
The authentication routes include donor, recipient, organization, and blood-bank login, plus a current-user profile route. The following endpoint URLs assume the authentication router is mounted under /api/auth and the backend is running on port 5000.
Method	Endpoint	Purpose
POST	/api/auth/donor/login	Authenticate a donor
POST	/api/auth/recipient/login	Authenticate a recipient
POST	/api/auth/organization/login	Authenticate an organization
POST	/api/auth/blood-bank/login	Authenticate a blood bank
GET	/api/auth/me	Retrieve the current authenticated user's profile


Login request example
The donor and recipient login APIs accept a JSON body containing a phone number and password. The controller also contains validation for identifier/email-based input, so follow the exact request format expected by the active frontend and backend route.
POST http://localhost:5000/api/auth/donor/login
Content-Type: application/json
{
  "phone": "YOUR_REGISTERED_PHONE",
  "password": "YOUR_PASSWORD"
}
For recipient login, change the endpoint to:
http://localhost:5000/api/auth/recipient/login
A successful login response includes a success message, a token, and safe account details. The password hash is not intended to be returned to the client. Do not put real passwords or tokens in source control, screenshots, or public issue reports.

The /api/auth/me route uses authentication middleware. Send the authentication token in the format expected by the current middleware implementation (commonly an Authorization: Bearer <token> header); confirm the exact header parsing in backend/middleware/authMiddleware.js.
How Authentication Works
At a high level, the controller follows this flow:
1. The frontend submits the login form to the relevant authentication route.
2. The Express router forwards the request to the matching controller, such as donorLogin() or recipientLogin().
3. The controller validates the input using the shared login-input helper.
4. The controller retrieves the matching account from MySQL.
5. The entered password is verified against the stored password hash using the shared password-verification helper.
6. When credentials are valid, the server creates a JWT and returns the token with safe account information.
7. For the current-user endpoint, authentication middleware checks the request before the controller retrieves the relevant profile.
Testing
Backend test files are present under backend/tests/, including tests related to authentication, requests, donor actions, notifications, inventory, and blood-bank integration. To run tests, inspect backend/package.json for the supported scripts and execute the project's configured test command from the backend/ directory.

Before reporting a feature as passing, verify the relevant tests and, where appropriate, manually check:
- Login with valid credentials
- Login with an incorrect password
- Empty or malformed input
- API behavior when the database/backend is unavailable
- Authenticated access to the current-user endpoint
- Frontend API integration for each implemented module
Do not mark a test as Pass merely because a page or route exists. Record the actual observed result and test status.
Security Notes
- Never commit database passwords, JWT secrets, real credentials, or access tokens.
- Do not return password_hash in API responses.
- Use parameterized SQL queries for user-supplied values.
- Protect private endpoints with authentication middleware and verify role/permission requirements where necessary.
- Use HTTPS and suitable secret management for deployment.
- Test access control for each user type before production deployment.
Troubleshooting
- Database connection fails: Check whether MySQL is running and verify settings used by backend/db.js.
- Connection refused / network error: Confirm that the backend server is running and the frontend API base URL is correct.
- 401 Unauthorized: Check the submitted credentials and, for protected endpoints, verify that the token is present and valid.
- 400 Bad Request: Check the request body and required fields.
- 500 Internal Server Error: Inspect the backend terminal logs for the underlying error; avoid exposing stack traces or secrets to end users.
- Frontend page does not load: Run npm install in frontend/ and use the dev-server URL printed by Vite.
- Tests do not run: Check the available scripts and test configuration in backend/package.json before choosing a command.
Contributing
1. Create or switch to the appropriate feature branch.
2. Keep each commit focused on one module or logical change.
3. Run the relevant tests before opening a pull request.
4. Review Files changed before merging and ensure unrelated modules are not included.
5. Never commit .env files or real credentials.
Project: LifeSaver — Blood Donation Management System
Repository: harshsharma181205/LifeSaver-Blood-Management-System