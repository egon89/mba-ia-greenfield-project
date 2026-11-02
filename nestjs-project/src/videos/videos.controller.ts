import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import {
  PartUrlsResponseDto,
  toPartUrlsResponse,
} from './dto/part-urls-response.dto';
import {
  toUploadedPartsResponse,
  UploadedPartsResponseDto,
} from './dto/uploaded-parts-response.dto';
import { toVideoResponse, VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

// The auth throttler (10 req/min) would break batched part-URL requests and
// player redirects (phase-02-auth/TD-08 exemption).
@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft on the caller's channel and opens the multipart upload in storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const { video, partSize, partCount } =
      await this.videosService.initiateUpload(user.sub, dto);
    return {
      ...toVideoResponse(video),
      upload: { part_size: partSize, part_count: partCount },
    };
  }

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Owner reads the video in any status, including the extracted metadata or the failure reason. Used to poll processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — unknown video or owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return toVideoResponse(
      await this.videosService.getOwnedVideo(user.sub, publicId),
    );
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue presigned part upload URLs',
    description:
      'Returns presigned UploadPart URLs on the public storage endpoint, each bound to the exact Content-Length of its part and valid for 1 hour.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs issued',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR or INVALID_PART_NUMBER (part number greater than part_count)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — unknown video or owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_ACTIVE — the video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async issuePartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return toPartUrlsResponse(
      await this.videosService.issuePartUrls(
        user.sub,
        publicId,
        dto.part_numbers,
      ),
    );
  }

  @Get(':publicId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Resume support: lists the parts already stored for the open multipart upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts listed',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — unknown video or owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_ACTIVE — the video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    return toUploadedPartsResponse(
      await this.videosService.listUploadedParts(user.sub, publicId),
    );
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload from the stored parts, checks the final size, moves the video to processing and enqueues its processing. Idempotent while the video is processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — unknown video or owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'UPLOAD_INCOMPLETE (missing parts) or VIDEO_UPLOAD_NOT_ACTIVE (video is ready or failed)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'UPLOAD_SIZE_MISMATCH — the video is marked failed and its objects are deleted',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return toVideoResponse(
      await this.videosService.completeUpload(user.sub, publicId),
    );
  }
}
