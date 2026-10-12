CREATE TABLE "gitlab_user_identity" (
	"id" text PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"gitlab_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gitlab_user_identity" ADD CONSTRAINT "gitlab_user_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_user_identity_instance_user_unique" ON "gitlab_user_identity" USING btree ("base_url","gitlab_user_id");--> statement-breakpoint
CREATE INDEX "gitlab_user_identity_user_idx" ON "gitlab_user_identity" USING btree ("user_id");