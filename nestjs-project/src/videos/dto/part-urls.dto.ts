import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_NUMBERS_PER_REQUEST } from '../videos.constants';

export class PartUrlsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2],
    minItems: 1,
    maxItems: MAX_PART_NUMBERS_PER_REQUEST,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_NUMBERS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
