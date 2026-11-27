import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { TelemetryExceptionFilter } from './telemetry-exception.filter';

describe('TelemetryExceptionFilter', () => {
  let filter: TelemetryExceptionFilter;
  const mockTelemetry: any = { track: jest.fn() };
  let mockRequest: any;
  let mockResponse: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new TelemetryExceptionFilter(mockTelemetry);
    mockRequest = {
      url: '/runs/latest?projectPath=%2FUsers%2Falice%2Fsecret-project',
      route: { path: '/runs/latest' },
      method: 'POST',
    };
    mockResponse = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockHost = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as unknown as ArgumentsHost;
    jest.clearAllMocks();
  });

  it('tracks HttpException with correct status', () => {
    const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

    filter.catch(exception, mockHost);

    expect(mockTelemetry.track).toHaveBeenCalledWith('service_error', {
      error_type: 'HttpException',
      route: '/runs/latest',
      method: 'POST',
      status_code: 404,
    });
  });

  it('returns HttpException response body', () => {
    const exception = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(exception.getResponse());
  });

  it('tracks generic Error as 500', () => {
    const exception = new Error('something broke');

    filter.catch(exception, mockHost);

    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'service_error',
      expect.objectContaining({
        error_type: 'Error',
        status_code: 500,
      }),
    );
  });

  it('returns generic 500 response for non-HttpException', () => {
    filter.catch(new Error('fail'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('tracks non-Error thrown values as Unknown', () => {
    filter.catch('string-error', mockHost);

    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'service_error',
      expect.objectContaining({ error_type: 'Unknown' }),
    );
  });

  // Before, the event had the message and the URL with its query, which
  // carry file paths and project names
  it('sends neither the message nor the URL', () => {
    filter.catch(
      new Error("ENOENT: no such file, open '/Users/alice/secret-project/a'"),
      mockHost,
    );

    const sent = JSON.stringify(mockTelemetry.track.mock.calls[0][1]);
    expect(sent).not.toContain('alice');
    expect(sent).not.toContain('secret-project');
  });

  it('sends a string error code', () => {
    filter.catch(
      Object.assign(new Error('open /Users/alice/x'), { code: 'ENOENT' }),
      mockHost,
    );

    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'service_error',
      expect.objectContaining({ error_code: 'ENOENT' }),
    );
  });

  it('names an unmatched route without its URL', () => {
    mockRequest.route = undefined;
    filter.catch(new HttpException('nope', 404), mockHost);

    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'service_error',
      expect.objectContaining({ route: 'unmatched' }),
    );
  });
});
