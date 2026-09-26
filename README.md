# YOLOTASK by Nifelux

**YOLOTASK** is a secure, scalable digital task and promotion marketplace connecting eligible Earners with Advertisers. 

> **Note:** This is NOT an investment platform. It is a promotional task marketplace.

## 🚀 Tech Stack
- **Frontend:** Vanilla HTML, CSS, JavaScript (Mobile-first, responsive)
- **Backend:** Vercel Serverless Functions (Exactly 7 API entry points)
- **Database:** Supabase PostgreSQL (with strict Row Level Security)
- **Authentication:** Supabase Auth
- **Payments:** Paystack (Wallet funding, secure webhooks)

## 📁 Architecture
- `/public` - Static frontend assets (HTML, CSS, JS)
- `/api` - The 7 serverless entry points (`auth`, `wallet`, `tasks`, `campaigns`, `payments`, `referrals`, `admin`)
- `/lib` - Reusable, secure business logic modules (ledger, validation, targeting)
- `/supabase` - Database migrations and seed data

## 🛠️ Local Development Setup

1. Clone the repository:
```bash
   git clone https://github.com/nifeluxtech/yolotask.git
   cd yolotask
```
2. Install dependencies:
```bash
   npm install
```
3. Copy environment variables and fill in your credentials:
```bash
   cp .env.example .env.local
```
4. Run the local Vercel development server:
```bash
   npm run dev
```

## 🔒 Security Principles
- **Zero Trust:** Frontend never calculates rewards, fees, or balances.
- **Immutable Ledger:** All financial movements are recorded in `wallet_ledger`.
- **Role Verification:** Every API endpoint validates the user's role server-side.
- **No Storage Bloat:** Task proofs are link-based to bypass Supabase storage limits.

## 📜 License
Proprietary. Copyright © 2026 Nifelux. All rights reserved.
