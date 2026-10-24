# LifeSaver — Smart Blood Donation & Allocation Platform

LifeSaver is a full-stack web application designed to connect blood donors, recipients, hospitals, and Blood Banks through a coordinated blood-request and donation workflow. It helps recipients request blood, enables eligible Blood Banks to manage and allocate available units, and provides a way to contact compatible donors when the available inventory cannot cover the requirement.

The application uses a **React** frontend, a **Node.js/Express** backend, and a **MySQL** database. It includes role-based authentication, request tracking, inventory management, donor notifications, medical screening, and donation confirmation.

## Table of Contents

- Features and Modules
- How LifeSaver Works
- Request Prioritization
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

## Features and Modules

### 1. User Authentication and Role-Based Access

LifeSaver provides account-based access for different users, including:

- **Donors** — view relevant blood requests, respond to donation opportunities, and track donation-related activity.
- **Recipients** — submit blood requirements and follow the status of their requests.
- **Hospitals** — appear as admission hospitals for patient requests and can follow the status of applicable admitted-patient requests.
- **Blood Banks and organizations** — manage applicable blood-request workflows, inventory contributions, donor screening, and confirmed collections according to their permissions.

Authentication uses JWT tokens. Protected operations use backend authorization checks so that users can only perform actions permitted for their role and the relevant request.

### 2. Blood Request Management

A recipient can submit a blood request with information such as:

- Required blood group
- Number of units needed
- Urgency level
- City and state
- Hospital of admission

Requests have tracked statuses, allowing the application to distinguish active requests from fulfilled, cancelled, or otherwise closed ones. Request details show the requested units, contributions already fulfilled, and remaining requirement.

### 3. Hospital and City-Wide Blood Bank Coordination

LifeSaver coordinates a request with eligible Blood Banks in the relevant city and state. Rather than relying on a single Blood Bank, multiple eligible Banks may contribute units from their respective inventories.

- A Bank can contribute available units without having to fulfill the complete request by itself.
- Allocations are recorded against the corresponding request and Bank inventory.
- Remaining units are calculated separately from units already fulfilled.
- Hospitals can follow the progress of the requests associated with their admitted patients; they do not directly manage Blood Bank stock.

### 4. Blood Bank Inventory Management

Blood Banks maintain records of available blood units. Inventory information is used to determine how much of a request can be supplied by eligible Banks.

**Inventory allocation and donor collection are different activities:** an accepted donor or an approved screening does not automatically increase inventory or fulfill a request. Blood is counted as donated only through the authorized actual-donation confirmation workflow.

### 5. Automatic Donor Matching and Notifications

When the combined available stock of eligible Blood Banks does not cover a request, LifeSaver can identify compatible donors for the **uncovered units** and notify them of the opportunity to donate.

The workflow covers both situations where no eligible stock is available and where some units are available but the request still has a shortage. It also avoids unnecessary additional donor fallback when the shortage is covered or the request is fulfilled.

The backend periodically reconciles open requests to keep matching and notifications aligned with current request and inventory conditions. Notification handling is designed to avoid duplicate alerts for the same applicable opportunity.

### 6. Donor Acceptance, Medical Screening, and Collection

A donor may accept a relevant blood request, after which medical screening and any actual collection are handled by the **designated collecting Blood Bank**.

The workflow separates the following steps:

1. A compatible donor receives or views a donation opportunity.
2. The donor accepts the request.
3. The designated Blood Bank performs the authorized medical screening.
4. If a genuine donation takes place, the authorized Bank confirms the actual collection.
5. The system updates the corresponding donation and fulfillment records as applicable.

An unrelated Blood Bank cannot screen or confirm collection for a donor assigned to another collecting Bank. Screening and donation actions are not available for cancelled or closed requests. **No PIN-based collection process is required.**

### 7. Dashboards and Notifications

Role-specific pages present relevant information, such as:

- Requests raised or received
- Requested, fulfilled, and remaining units
- Inventory contributions and related status
- Donor acceptance and screening status
- Designated collecting Blood Bank
- Request-related notifications and updates

Information and actions are filtered according to the signed-in user's role and permissions.

## How LifeSaver Works

The following is the overall workflow for a blood requirement:

```
Recipient creates a blood request
               |
               v
Hospital, blood group, units, urgency and location are recorded
               |
               v
Eligible Blood Banks are identified for the relevant city/state
               |
               v
Available inventory can be allocated by one or more Banks
               |
               v
       Is the shortage covered?
          /               \
        Yes                No
         |                  |
         |                  v
         |       Compatible donors are notified
         |                  |
         |                  v
         |       Donor accepts the opportunity
         |                  |
         |                  v
         |       Designated Blood Bank screens donor
         |                  |
         |                  v
         |       Actual donation is confirmed, if made
         |                  |
         +------------------+
                            |
                            v
             Request status and fulfillment are updated
```

The application distinguishes **remaining request units** from **uncovered donor units**. Remaining units represent blood not yet fulfilled; uncovered donor units represent the shortage after considering currently eligible Blood Bank inventory. These numbers need not be the same.

## Request Prioritization

LifeSaver incorporates **non-preemptive Priority Scheduling with First-Come, First-Served (FCFS)** ordering:

- Requests are considered according to their applicable priority or urgency.
- Where the scheduling rules assign equal priority, FCFS preserves request order.
- Non-preemptive scheduling means an allocation already being processed is not arbitrarily interrupted by a newly arrived request.

Request prioritization works alongside inventory availability, eligibility, and request-state checks.

## Technology Stack

| Layer               | Technologies                                                         |
| ------------------- | -------------------------------------------------------------------- |
| Frontend            | React, JavaScript, CSS, Vite                                         |
| Client-side routing | React Router                                                         |
| API communication   | HTTP/JSON, Axios where used                                          |
| Backend             | Node.js, Express.js                                                  |
| Database            | MySQL                                                                |
| Authentication      | JWT and password verification                                        |
| Testing             | Backend unit/integration tests, frontend tests, browser-based checks |

## Project Structure

```
LifeSaver/
├── backend/
│   ├── controllers/      # Request handlers and controller logic
│   ├── routes/           # API route definitions
│   ├── middleware/       # Authentication and authorization middleware
│   ├── services/         # Business logic, allocation and matching services
│   ├── migrations/       # Database migration scripts
│   ├── tests/            # Backend tests
│   ├── db.js             # Database connection configuration
│   └── index.js          # Backend entry point
└── frontend/
    ├── src/
    │   ├── components/   # Reusable UI components
    │   ├── context/      # Shared React state/context
    │   ├── pages/        # Role-specific screens and dashboards
    │   ├── services/     # API integration helpers
    │   ├── styles/       # Stylesheets
    │   └── utils/        # Client-side utilities
    └── tests/            # Frontend tests
```

The structure above highlights important directories rather than every file in the repository.

## Requirements

Before running LifeSaver locally, install:

- Node.js and npm
- MySQL Server
- Git (optional, if cloning from a repository)

Ensure both the frontend and backend dependencies are installed and that MySQL is running.

## Setup and Run Locally

### 1. Open the project

Open your existing LifeSaver project directory, or clone the repository:

```
git clone https://github.com/harshsharma181205/LifeSaver.git
cd LifeSaver
```

If you already have a configured installation, **use the existing project and database** rather than recreating them.

### 2. Configure the database and environment

1. Start the MySQL service.
2. Configure the database connection using the settings expected by `backend/db.js` and the local environment file.
3. Ensure the required database schema and migrations have been set up for the installation.
4. Keep passwords, JWT secrets, and other private configuration out of source control.

The existing local application uses a MySQL database named `blood_management`. Do not reset an existing populated database or rerun migrations indiscriminately.

Example workflow-related environment settings:

```
JWT_EXPIRES_IN=1h
LIFESAVER_WORKFLOW_V2=true
```

`JWT_EXPIRES_IN` specifies the lifetime of a login token, not how long the website remains running. `LIFESAVER_WORKFLOW_V2` enables the hospital and city-wide request workflow. These values remain saved in the environment file; they do not need to be typed again on every start.

### 3. Start the backend

In one terminal, from the project directory:

```
cd backend
npm install
node index.js
```

Alternatively, use a startup script declared in `backend/package.json` if one is configured. The local backend is typically available at `http://localhost:5000`.

### 4. Start the frontend

In another terminal, from the project directory:

```
cd frontend
npm install
npm run dev
```

Open the URL shown by Vite, typically [**http://localhost:5173**](http://localhost:5173).

### 5. Verify connectivity

- Make sure MySQL, the backend, and the frontend are running.
- Check that the frontend is calling the correct backend API URL.
- Sign in with an existing account and check the appropriate dashboard.
- Inspect terminal output and browser developer tools if a request fails.

If the computer is restarted, the servers may need to be started again unless automatic startup has been configured. Database migrations and environment settings do **not** need to be repeated simply to reopen the application.

## Authentication API

LifeSaver includes role-specific authentication routes. The following endpoints are based on the authentication router being mounted at `/api/auth`:

| Method | Endpoint                       | Purpose                              |
| ------ | ------------------------------ | ------------------------------------ |
| `POST` | `/api/auth/donor/login`        | Sign in as a donor                   |
| `POST` | `/api/auth/recipient/login`    | Sign in as a recipient               |
| `POST` | `/api/auth/organization/login` | Sign in as an organization           |
| `POST` | `/api/auth/blood-bank/login`   | Sign in as a Blood Bank              |
| `GET`  | `/api/auth/me`                 | Get the authenticated user's profile |

### Login request example

```
POST http://localhost:5000/api/auth/donor/login
Content-Type: application/json
```

```
{
  "phone": "YOUR_REGISTERED_PHONE",
  "password": "YOUR_PASSWORD"
}
```

Use the recipient login endpoint for a recipient account. Actual accepted identifiers and payload requirements should be checked against the active authentication route and frontend form.

Successful login returns authentication information, including a JWT token and safe account details. Protected routes require the token in the format expected by the authentication middleware, commonly:

```
Authorization: Bearer YOUR_JWT_TOKEN
```

## How Authentication Works

1. A user enters credentials in the appropriate login form.
2. The frontend sends the credentials to the matching backend authentication endpoint.
3. The controller validates the request and looks up the account in MySQL.
4. The supplied password is checked against the stored password verification data.
5. After successful authentication, the backend issues a JWT token.
6. The frontend uses the token for authenticated API requests.
7. Middleware checks authentication and applicable permissions before allowing protected operations.

## Testing

The project includes tests covering different parts of the application, including authentication, blood requests, inventory, allocation, notifications, donor interactions, and permission checks. Frontend tests and browser-based checks complement backend tests.

For local development:

1. Review the test scripts in the appropriate `package.json` files.
2. Run the relevant unit tests after making changes.
3. Run database integration tests **only on a separate, isolated test database** with a restricted test user.
4. Check role-specific behavior in the browser, including open versus cancelled requests.
5. Verify that request allocation, screening, and confirmed collection remain separate operations.

Do not run tests that create, modify, or delete records against a populated production or primary project database.

## Security Notes

- Never commit `.env` files, database passwords, JWT secrets, real user credentials, or access tokens.
- Do not return password hashes in API responses.
- Use parameterized queries for database access.
- Enforce authentication and role authorization on protected backend routes.
- Restrict screening and collection actions to the designated collecting Blood Bank.
- Prevent changes to closed requests unless an explicitly authorized workflow allows them.
- Use HTTPS and secure secret management for an internet-facing deployment.
- Treat donor contact details and medical information as sensitive.

## Troubleshooting

| Problem                              | What to check                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Frontend does not open               | Confirm Vite is running and use the URL printed in its terminal.                                                       |
| API/network error                    | Confirm the backend process is running and frontend API settings point to the right port.                              |
| Database connection failed           | Verify MySQL service status and the backend database configuration.                                                    |
| `401 Unauthorized`                   | Check account credentials and whether the JWT is expired or missing.                                                   |
| `403 Forbidden` / unavailable action | Check the account role, designated Blood Bank, and whether the request is open.                                        |
| Screening action not visible         | Confirm the donor is accepted, the request is open, and the signed-in Bank is the designated collecting Bank.          |
| No donor notification                | Check request status, blood-group compatibility, eligible Bank inventory, matching conditions, and notification state. |
| Unexpected fulfillment count         | Distinguish inventory allocation, donor acceptance, screening, and actual confirmed donation.                          |
| CORS or browser request failure      | Inspect backend configuration, browser Network tab, and backend logs.                                                  |

## Contributing

Contributions should be focused and tested:

1. Make changes in the correct project directory.
2. Keep unrelated modules and database records untouched.
3. Use isolated databases for tests that write data.
4. Verify authentication, authorization, and request-state behavior for any workflow change.
5. Review the changed files before committing and never commit credentials.

---

**Project:** LifeSaver — Smart Blood Donation & Allocation Platform\
**Repository:** [harshsharma181205/LifeSaver](https://github.com/harshsharma181205/LifeSaver)