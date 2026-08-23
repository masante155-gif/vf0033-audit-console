# VF-0033 GMP Audit 

A GMP weekly workplace inspection audit tool — 99-item checklist, live Non-Conformance Log, shift-supervisor acknowledgment gate before SQF sign-off, photo attachments, PDF export, and admin-editable checklist/settings.

## Run locally

```
npm install
npm start
```

Server listens on `PORT` (default 8080). Data persists to `DATA_DIR` (default `./data`), which holds the SQLite database and uploaded photos.

## Admin passcode

Default admin passcode is `GMP2026` — change it from the Admin panel once deployed.
