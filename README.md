# Prism deployment

The app and API are separate repositories. This repository is the backend (`prime_backend`); the frontend is `prime_frontend`.

- API web service: build `npm ci`, start `npm start`, health check `/api/health`.
- Frontend static site: build `npm ci && npm run build`, publish directory `dist`.

For Blueprint setup, choose `render.yaml` as the Blueprint file path in Render. The frontend connects directly to the backend, so no frontend API rewrite is required.

Set `MONGODB_URI` and `ADMIN_PASSWORD` in the API service's Render Environment settings. `SESSION_SECRET` is generated in the Blueprint; `APP_ORIGIN` must match the frontend URL (`https://prism-app.onrender.com`) or be updated for a custom domain. Configure MongoDB Atlas Network Access to allow the deployed API.

Contact-form email delivery uses SMTP. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`, and `ENQUIRY_TO_EMAIL`. For Google Workspace or Gmail, use `smtp.gmail.com`, port `587`, `SMTP_SECURE=false`, the full mailbox as both `SMTP_USER` and `MAIL_FROM`, and a Google App Password created by that same mailbox as `SMTP_PASSWORD`. Display spaces or hyphens in Google app passwords are removed automatically. Keep all SMTP values in the backend environment only; never commit the password.

Run `npm run smtp:test` in the backend environment to verify the SMTP connection and login without sending an email. A Gmail `535` response means the configured username and app password do not belong together, the app password was revoked, or Google Workspace policy is blocking SMTP authentication.

Copy `.env.example` to `.env` for local API development. Run `npm ci`, `npm run dev`, `npm run db:migrate`, or `npm run admin:set`. The frontend uses relative `/api` requests; do not place backend secrets in frontend environment variables.

After the first deployment, open the API service Shell and run `npm run admin:set` once to provision the administrator from `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
