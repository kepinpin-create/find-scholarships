import { discoverScholarships } from "@/lib/ai/orchestrator";
import { studentProfileSchema } from "@/lib/schemas/student";

/**
 * POST /api/discover
 * Validates the profile, runs the discovery pipeline server-side, and
 * returns structured results. API keys never leave the server.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const profile = studentProfileSchema.safeParse(
    typeof body === "object" && body !== null && "profile" in body
      ? (body as { profile: unknown }).profile
      : body,
  );
  if (!profile.success) {
    return Response.json(
      {
        error: "Invalid student profile",
        issues: profile.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const result = await discoverScholarships(profile.data);
  return Response.json(result, {
    status: result.status === "not_configured" ? 503 : 200,
  });
}
