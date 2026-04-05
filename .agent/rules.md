# Yūgen Study - Core Project Rules

These rules are ALWAYS loaded and must be followed for all development and interaction with this project.

## 🧘 Aesthetic & UI Philosophy
*   **Typography-First**: The app is built on high-fidelity typography (`Shippori Mincho` and `Inter`) and optimal white space (line-height: 2).
*   **Zen Minimalist**: Avoid heavy UI elements, shadows, or borders. Use the established subtle earthy palette defined as CSS variables in `index.css`.
*   **No Placeholders**: Never use generic placeholder images; use `generate_image` for realistic high-fidelity assets.

## 🛠️ Interaction Workflow
*   **GitHub CLI**: Prefer using the `gh` command for managing issues, tracking technical debt, and updating project boards.
*   **Task Tracking**: Maintain `docs/task.md` synchronously with actual project progress.
*   **Private Beta Gate**: The app uses a granular `check_is_approved` RPC in Supabase. Beta access must be managed via the `waitlist` table's `is_approved` column.

## 🏗️ Technical Architecture
*   **Serverless Proxy**: Production NewsAPI fetches MUST go through the `/api/news` Vercel function to avoid CORS/Browser-key restrictions.
*   **State Management**: Local persistence is handled by Zustand with a `yugen-storage` key (versioned).
*   **SRS Logic**: The Spaced Repetition threshold (Auto-Bump) defaults to **3**.
