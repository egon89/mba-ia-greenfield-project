import { ApiProperty } from '@nestjs/swagger';
import type { UploadedPartsSummary } from '../videos.service';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}

export function toUploadedPartsResponse({
  partSize,
  partCount,
  uploadedParts,
}: UploadedPartsSummary): UploadedPartsResponseDto {
  return {
    part_size: partSize,
    part_count: partCount,
    uploaded_parts: uploadedParts.map(({ partNumber, size }) => ({
      part_number: partNumber,
      size,
    })),
  };
}
