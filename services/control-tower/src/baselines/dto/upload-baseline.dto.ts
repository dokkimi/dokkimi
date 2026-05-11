import { IsString, Length, Matches } from 'class-validator';

const BASELINE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Multipart upload payload for POST /baselines. The PNG bytes live on the
 * `payload` file field (handled by FileInterceptor at the controller).
 *
 * Baselines are user inputs (checked into git at
 * .dokkimi/<project>/baselines/<name>.png). The CLI uploads them at
 * run-start so CT's post-run visualMatch diff job can read them locally.
 */
export class UploadBaselineDto {
  @IsString()
  instanceId!: string;

  @IsString()
  @Length(1, 64)
  @Matches(BASELINE_NAME_PATTERN, {
    message:
      'name must match [a-zA-Z0-9_-]{1,64} (alphanumeric, dash, underscore)',
  })
  name!: string;
}
