import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ description: 'HTTP状态码', example: 400 })
  statusCode: number;

  @ApiProperty({
    description: '错误信息',
    example: '请求参数错误',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message: string | string[];

  @ApiProperty({ description: '错误类型', example: 'Bad Request' })
  error: string;

  @ApiProperty({ description: '时间戳', example: '2024-01-01T00:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ description: '请求路径', example: '/agents' })
  path: string;

  constructor(
    statusCode: number,
    message: string | string[],
    error: string,
    path: string,
  ) {
    this.statusCode = statusCode;
    this.message = message;
    this.error = error;
    this.timestamp = new Date().toISOString();
    this.path = path;
  }
}
