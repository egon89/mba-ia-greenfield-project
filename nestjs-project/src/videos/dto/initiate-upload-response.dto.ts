import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPlanDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}

export class InitiateUploadResponseDto extends VideoResponseDto {
  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
