import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { RunsService } from './runs.service';

/**
 * A submission Control Tower rejects (a definition that fails validation,
 * or an error storing it) fails its instance, so the run can end. Before,
 * the instance stayed PENDING and the CLI waited forever. The error still
 * reaches the client, and the global filters, unchanged.
 */
@Injectable()
export class SubmissionRejectedInterceptor implements NestInterceptor {
  constructor(private readonly runs: RunsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { runId, instanceId } = context.switchToHttp().getRequest<{
      params: { runId: string; instanceId: string };
    }>().params;
    return next
      .handle()
      .pipe(
        catchError((err: unknown) =>
          from(this.runs.rejectSubmission(runId, instanceId, err)).pipe(
            mergeMap(() => throwError(() => err)),
          ),
        ),
      );
  }
}
