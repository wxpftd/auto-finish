// Universal load — keeping the dashboard purely client-rendered for now
// (no server-side data fetching until the orchestrator HTTP layer is wired).
export const ssr = false;
export const prerender = false;

export const load = () => ({});
