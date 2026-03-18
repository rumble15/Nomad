# NOMAD

**Navigation Organizer for Maps, Activities & Destinations**

A self-hosted travel planner for organizing trips, places, budgets, packing lists, and more.

![License](https://img.shields.io/github/license/mauriceboe/NOMAD)

## Features

- **Drag & Drop Planner** — Organize places into day plans with drag & drop
- **Google Maps Integration** — Search and auto-fill place details
- **Budget Tracking** — Track expenses per trip with pie chart overview
- **Packing Lists** — Grouped lists with progress tracking and suggestions
- **Photo Gallery** — Upload and manage trip photos
- **File Storage** — Attach documents, tickets, and PDFs to trips
- **Reservations** — Track booking status and details
- **Weather** — Weather forecasts for your destinations
- **PDF Export** — Export trip plans as PDF
- **Multi-User** — Invite members to collaborate on trips
- **Admin Panel** — User management, backups, and app settings
- **Dark Mode** — Full light/dark theme support
- **i18n** — English and German

## Tech Stack

- **Backend**: Node.js 22 + Express + SQLite (`node:sqlite`)
- **Frontend**: React 18 + Vite + Tailwind CSS
- **State**: Zustand
- **Auth**: JWT
- **Maps**: Leaflet + Google Places API
- **Icons**: lucide-react

## Deployment with Docker

### Prerequisites

- Docker & Docker Compose
- A Google Maps API key (optional, for place search)

### 1. Clone the repository

```bash
git clone https://github.com/mauriceboe/NOMAD.git
cd NOMAD
```

### 2. Configure environment

```bash
cp server/.env.example .env
```

Edit the `.env` or set variables in `docker-compose.yml`:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret key for JWT signing (min. 32 characters) |
| `ALLOWED_ORIGINS` | No | Comma-separated list of allowed origins (default: `http://localhost:3000`) |
| `PORT` | No | Server port (default: `3000`) |

### 3. Start the app

```bash
docker compose up -d --build
```

The app is now running. Open your browser and navigate to your server's IP or domain on port `3000`.

### 4. First setup

The first user to register automatically becomes the **admin**. No default credentials — you create your own account.

### Updating

```bash
git pull
docker compose up -d --build
```

Your data is persisted in the `./data` and `./uploads` volumes.

### Reverse Proxy (recommended)

For production, put NOMAD behind a reverse proxy (Nginx, Caddy, Traefik) with HTTPS.

Example with **Caddy** (`Caddyfile`):

```
nomad.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Update `ALLOWED_ORIGINS` in `docker-compose.yml` to match your domain:

```yaml
environment:
  - ALLOWED_ORIGINS=https://nomad.yourdomain.com
```

## Google Maps API Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Places API (New)**
3. Create an API key under Credentials
4. In NOMAD: Admin Panel → API Keys → enter your key

## Data & Backups

- **Database**: SQLite, stored in `./data/travel.db`
- **Uploads**: Stored in `./uploads/`
- **Backups**: Can be created and managed in the Admin Panel
- **Auto-Backups**: Configurable schedule in Admin Panel

## License

[MIT](LICENSE)
