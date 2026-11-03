import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793645223755 implements MigrationInterface {
  name = 'CreateVideos1793645223755';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "failure_reason" character varying(50), "original_filename" character varying(255) NOT NULL, "content_type" character varying(255) NOT NULL, "declared_size_bytes" bigint NOT NULL, "upload_id" character varying(255), "size_bytes" bigint, "duration_seconds" double precision, "width" integer, "height" integer, "mime_type" character varying(255), "video_codec" character varying(50), "audio_codec" character varying(50), "bitrate" integer, "frame_rate" double precision, "thumbnail_key" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_39a1f0fe7991162aace659078e" ON "videos" ("public_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f12537731f957a3ff27bc19f47" ON "videos" ("status", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fa92ce74fa6331a7ad7743dea5" ON "videos" ("status", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fa92ce74fa6331a7ad7743dea5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f12537731f957a3ff27bc19f47"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_39a1f0fe7991162aace659078e"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
