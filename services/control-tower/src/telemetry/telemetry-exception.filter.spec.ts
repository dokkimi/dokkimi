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
    mockRequest = { url: '/api/test', method: 'POST' };
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
      error_message: 'Not Found',
      route: '/api/test',
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
        error_message: 'something broke',
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

  it('tracks non-Error thrown values with String coercion', () => {
    filter.catch('string-error', mockHost);

    expect(mockTelemetry.track).toHaveBeenCalledWith(
      'service_error',
      expect.objectContaining({
        error_type: 'Unknown',
        error_message: 'string-error',
      }),
    );
  });

  it('truncates long error messages to 200 chars', () => {
    const longMessage = 'x'.repeat(300);
    filter.catch(new Error(longMessage), mockHost);

    const call = mockTelemetry.track.mock.calls[0][1];
    expect(call.error_message).toHaveLength(200);
  });
});
