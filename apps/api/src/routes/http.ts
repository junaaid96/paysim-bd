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

/**
 * Workspace keys come from the dashboard URL (?workspace=...). A well-formed
 * key that has no row yet is a brand-new, empty workspace: live feeds for it
 * connect normally and simply stay quiet until data arrives.
 */
export const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isWellFormedWorkspaceKey(key: string): boolean {
  return WORKSPACE_KEY_PATTERN.test(key);
}
