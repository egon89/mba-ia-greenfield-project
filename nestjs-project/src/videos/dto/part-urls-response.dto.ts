import { ApiProperty } from '@nestjs/swagger';
import type { IssuedPartUrls } from '../videos.service';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned PUT URL on the public storage endpoint',
  })
  url: string;

  @ApiProperty({
    example: 67108864,
    description: 'Exact byte count the client must send for this part',
  })
  content_length: number;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ example: 3600, description: 'URL lifetime in seconds' })
  expires_in: number;
}

export function toPartUrlsResponse({
  parts,
  expiresIn,
}: IssuedPartUrls): PartUrlsResponseDto {
  return {
    parts: parts.map(({ partNumber, url, contentLength }) => ({
      part_number: partNumber,
      url,
      content_length: contentLength,
    })),
    expires_in: expiresIn,
  };
}
