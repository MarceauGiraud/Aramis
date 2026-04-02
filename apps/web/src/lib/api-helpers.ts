import { NextResponse } from 'next/server';
import { z, ZodSchema } from 'zod';

/**
 * Standard API error response format
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Create a standard error response
 */
export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
    { status },
  );
}

/**
 * Pagination result type
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
}

/**
 * Parse pagination params from URL search params
 */
export function parsePagination(searchParams: URLSearchParams): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Create a paginated response
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): NextResponse<PaginatedResponse<T>> {
  const totalPages = Math.ceil(total / limit);
  return NextResponse.json({
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    },
  });
}

/**
 * Validate request body against a Zod schema.
 * Returns parsed data on success, or a NextResponse error on failure.
 */
export async function validateBody<T>(
  schema: ZodSchema<T>,
  body: unknown,
): Promise<{ data: T } | { error: NextResponse<ApiErrorResponse> }> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return {
      error: apiError('VALIDATION_ERROR', 'Invalid request body', 400, details),
    };
  }
  return { data: result.data };
}

/**
 * Parse JSON body from request, returning error response if invalid
 */
export async function parseJsonBody(
  request: Request,
): Promise<{ data: unknown } | { error: NextResponse<ApiErrorResponse> }> {
  try {
    const data = await request.json();
    return { data };
  } catch {
    return { error: apiError('INVALID_JSON', 'Invalid JSON body', 400) };
  }
}

/**
 * Placeholder auth helper - returns demo user ID.
 * Auth is handled by the parent SaaS.
 */
export function getCurrentUserId(): string {
  return 'demo-user';
}
