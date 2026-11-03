import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  @IsString()
  @Matches(/^video\//)
  @MaxLength(255)
  content_type: string;
}
