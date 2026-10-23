import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSettings } = await import("@/lib/auth.server");
        const s = await getSettings();
        if (request.headers.get("x-cron-secret") !== s.cron_secret) {
          return new Response("Unauthorized", { status: 401 });
        }
        const { runTick } = await import("@/lib/worker.server");
        const r = await runTick();
        return Response.json(r);
      },
      GET: async () => {
        // Allows public webhook / cron-job.org / Cloud Scheduler to trigger translation in the cloud
        const { runTick } = await import("@/lib/worker.server");
        const r = await runTick();
        return Response.json(r);
      },
    },
  },
});
