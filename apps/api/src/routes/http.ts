import type { Response } from 'express';
import type { z } from 'zod';

export function sendError(
  res: Response,
  status: number,
  code: string,
  detail?: { message?: string; issues?: string[] },
): void {
  res.status(status).json({ error: code, ...detail });
}

export function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}
