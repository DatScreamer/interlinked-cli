interface Env {
  ASSETS: Fetcher;
}

const HEALTH_PATH = "/healthz";

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH) {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export default handler;
