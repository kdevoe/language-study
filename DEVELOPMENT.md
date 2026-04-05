# Development & Interaction Guide - Yūgen Study

This guide serves as a "memory" for AI assistants and developers on how to interact with this specific project's infrastructure and preferred workflows.

## 🛠️ Preferred Workflows

### 1. Task & Issue Tracking
*   **Method**: Always prefer the **`gh` CLI** for managing issues and project items. 
*   **Manual Checks**: Before starting major work, check `gh issue list` and the GitHub Project board for pending refinements.

### 2. Private Beta & Whitelist Management
*   **Access Control**: The app uses a granular beta gate in `App.tsx`.
*   **User Approval**: Manage beta access by toggling the `is_approved` column in the **`waitlist`** table within the Supabase dashboard.
*   **Granular Status**: The Supabase RPC `check_is_approved` returns:
    *   `approved`: Full access.
    *   `waitlisted`: Signed up, awaiting approval.
    *   `not_joined`: User must sign up on the landing page first.

### 3. Environment & Deployment
*   **Proxying**: Note that `fetchNewsFeed` uses a `/api/news` Vercel proxy in production. It only enforces a client-side `VITE_NEWS_API_KEY` on `localhost`.
*   **Variables**: Ensure `VITE_NEWS_API_KEY`, `VITE_GEMINI_API_KEY`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` are configured in both `.env` and Vercel Dashboard.

## 🎨 Aesthetic Guidelines
*   **Zen Minimalist**: Always prioritize typography (`Shippori Mincho`, `Inter`) and white space.
*   **No Ad-hoc Utilities**: Use the existing Vanilla CSS variables (`--bg-color`, `--text-main`, etc.) defined in `index.css`.
