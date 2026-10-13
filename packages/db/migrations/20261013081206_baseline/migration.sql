CREATE TABLE "account" (
	"id" uuid PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"issuer" text DEFAULT 'akashic',
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"email" citext NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"banned_at" timestamp with time zone,
	"ban_reason" text,
	"banned_until" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY,
	"message_type" text NOT NULL,
	"routing_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb,
	"status" smallint DEFAULT 0 NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_kind" smallint NOT NULL,
	"subject_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_rsvp" (
	"event_id" uuid,
	"user_id" uuid,
	"status" smallint DEFAULT 0 NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_rsvp_pkey" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" text,
	"image_url" text,
	"capacity" integer,
	"comments_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"type" smallint DEFAULT 0 NOT NULL,
	"budget_cents" integer,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"hiring_flow" text,
	"hired_user_id" uuid,
	"hired_at" timestamp with time zone,
	"comments_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"image_url" text,
	"status" smallint DEFAULT 0 NOT NULL,
	"buyer_id" uuid,
	"sold_at" timestamp with time zone,
	"comments_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_interest" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_kind" smallint NOT NULL,
	"subject_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realm_endorsement" (
	"realm_id" uuid,
	"endorser_id" uuid,
	"candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realm_endorsement_pkey" PRIMARY KEY("realm_id","endorser_id","candidate_id")
);
--> statement-breakpoint
CREATE TABLE "realm_fit_queue" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_kind" smallint NOT NULL,
	"subject_id" uuid NOT NULL,
	"distance" double precision NOT NULL,
	"embedding" vector(1536),
	"kept_by" uuid,
	"kept" boolean,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realm_member" (
	"realm_id" uuid,
	"user_id" uuid,
	"role" smallint DEFAULT 0 NOT NULL,
	"display_name" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realm_member_pkey" PRIMARY KEY("realm_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "realm_module" (
	"realm_id" uuid,
	"module" smallint,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realm_module_pkey" PRIMARY KEY("realm_id","module")
);
--> statement-breakpoint
CREATE TABLE "realm_proposal" (
	"id" uuid PRIMARY KEY,
	"slug" citext NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"modules" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"rationale" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"realm_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realm" (
	"id" uuid PRIMARY KEY,
	"slug" citext NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"created_by" uuid NOT NULL,
	"centroid" vector(1536),
	"centroid_samples" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recall_vote" (
	"recall_id" uuid,
	"voter_id" uuid,
	"agree" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recall_vote_pkey" PRIMARY KEY("recall_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "recall" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" smallint NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takedown_vote" (
	"takedown_id" uuid,
	"voter_id" uuid,
	"agree" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "takedown_vote_pkey" PRIMARY KEY("takedown_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "takedown" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_kind" smallint DEFAULT 0 NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_block" (
	"room_id" uuid,
	"blocker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_block_pkey" PRIMARY KEY("room_id","blocker_id")
);
--> statement-breakpoint
CREATE TABLE "room_message_key" (
	"message_id" uuid,
	"fingerprint" text,
	"wrapped_key" text NOT NULL,
	"iv" text NOT NULL,
	CONSTRAINT "room_message_key_pkey" PRIMARY KEY("message_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "room_message" (
	"id" uuid PRIMARY KEY,
	"room_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"iv" text NOT NULL,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_report" (
	"id" uuid PRIMARY KEY,
	"room_id" uuid NOT NULL,
	"message_id" uuid,
	"reporter_id" uuid NOT NULL,
	"accused_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"disclosed_text" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" uuid PRIMARY KEY,
	"realm_id" uuid NOT NULL,
	"subject_kind" smallint NOT NULL,
	"subject_id" uuid NOT NULL,
	"low_user_id" uuid NOT NULL,
	"high_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"retention_days" smallint,
	"retention_agreed_by" uuid[]
);
--> statement-breakpoint
CREATE TABLE "user_key" (
	"user_id" uuid,
	"public_key" text NOT NULL,
	"signing_key" text,
	"fingerprint" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_key_pkey" PRIMARY KEY("user_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" smallint NOT NULL,
	"changes" jsonb,
	"trace_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_account_provider" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "ix_account_user" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_session_token" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "ix_session_user_expiry" ON "session" ("user_id","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_user_email" ON "user" ("email");--> statement-breakpoint
CREATE INDEX "ix_user_name_trgm" ON "user" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_user_email_trgm" ON "user" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_verification_identifier" ON "verification" ("identifier","expires_at");--> statement-breakpoint
CREATE INDEX "ix_outbox_messages_pending" ON "outbox_messages" ("next_attempt_at","id") WHERE status = 0;--> statement-breakpoint
CREATE INDEX "ix_comment_subject" ON "comment" ("subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_event_rsvp_status" ON "event_rsvp" ("event_id","status");--> statement-breakpoint
CREATE INDEX "ix_event_realm_start" ON "event" ("realm_id","starts_at");--> statement-breakpoint
CREATE INDEX "ix_job_realm_status" ON "job" ("realm_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_listing_realm_status" ON "listing" ("realm_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_posting_interest_once" ON "posting_interest" ("subject_kind","subject_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_posting_interest_subject" ON "posting_interest" ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE INDEX "ix_endorsement_candidate" ON "realm_endorsement" ("realm_id","candidate_id");--> statement-breakpoint
CREATE INDEX "ix_fit_queue_pending" ON "realm_fit_queue" ("realm_id","kept","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_fit_queue_subject" ON "realm_fit_queue" ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "ix_realm_member_role" ON "realm_member" ("realm_id","role");--> statement-breakpoint
CREATE INDEX "ix_realm_member_user" ON "realm_member" ("user_id");--> statement-breakpoint
CREATE INDEX "ix_proposal_pending" ON "realm_proposal" ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_proposal_by_user" ON "realm_proposal" ("proposed_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_realm_slug" ON "realm" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_recall_open" ON "recall" ("realm_id","subject_id") WHERE status = 0;--> statement-breakpoint
CREATE INDEX "ix_recall_open" ON "recall" ("realm_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_takedown_open" ON "takedown" ("realm_id","subject_kind","subject_id") WHERE status = 0;--> statement-breakpoint
CREATE INDEX "ix_takedown_open" ON "takedown" ("realm_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_room_message_room" ON "room_message" ("room_id","id");--> statement-breakpoint
CREATE INDEX "ix_room_report_open" ON "room_report" ("reviewed_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_room_pair_subject" ON "room" ("subject_kind","subject_id","low_user_id","high_user_id");--> statement-breakpoint
CREATE INDEX "ix_room_low_recent" ON "room" ("low_user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ix_room_high_recent" ON "room" ("high_user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ix_user_key_user" ON "user_key" ("user_id","seen_at");--> statement-breakpoint
CREATE INDEX "ix_audit_entity" ON "audit_entries" ("entity_type","entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_rsvp" ADD CONSTRAINT "event_rsvp_event_id_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_rsvp" ADD CONSTRAINT "event_rsvp_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_hired_user_id_user_id_fkey" FOREIGN KEY ("hired_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_seller_id_user_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_buyer_id_user_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "posting_interest" ADD CONSTRAINT "posting_interest_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "posting_interest" ADD CONSTRAINT "posting_interest_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_endorsement" ADD CONSTRAINT "realm_endorsement_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_endorsement" ADD CONSTRAINT "realm_endorsement_endorser_id_user_id_fkey" FOREIGN KEY ("endorser_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_endorsement" ADD CONSTRAINT "realm_endorsement_candidate_id_user_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_fit_queue" ADD CONSTRAINT "realm_fit_queue_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_fit_queue" ADD CONSTRAINT "realm_fit_queue_kept_by_user_id_fkey" FOREIGN KEY ("kept_by") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "realm_member" ADD CONSTRAINT "realm_member_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_member" ADD CONSTRAINT "realm_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_module" ADD CONSTRAINT "realm_module_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_proposal" ADD CONSTRAINT "realm_proposal_proposed_by_user_id_fkey" FOREIGN KEY ("proposed_by") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "realm_proposal" ADD CONSTRAINT "realm_proposal_decided_by_user_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "realm_proposal" ADD CONSTRAINT "realm_proposal_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "realm" ADD CONSTRAINT "realm_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "recall_vote" ADD CONSTRAINT "recall_vote_recall_id_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recall"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recall_vote" ADD CONSTRAINT "recall_vote_voter_id_user_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recall" ADD CONSTRAINT "recall_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recall" ADD CONSTRAINT "recall_subject_id_user_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recall" ADD CONSTRAINT "recall_proposed_by_user_id_fkey" FOREIGN KEY ("proposed_by") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "takedown_vote" ADD CONSTRAINT "takedown_vote_takedown_id_takedown_id_fkey" FOREIGN KEY ("takedown_id") REFERENCES "takedown"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "takedown_vote" ADD CONSTRAINT "takedown_vote_voter_id_user_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "takedown" ADD CONSTRAINT "takedown_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "takedown" ADD CONSTRAINT "takedown_proposed_by_user_id_fkey" FOREIGN KEY ("proposed_by") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_block" ADD CONSTRAINT "room_block_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_block" ADD CONSTRAINT "room_block_blocker_id_user_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_message_key" ADD CONSTRAINT "room_message_key_message_id_room_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "room_message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_sender_id_user_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_report" ADD CONSTRAINT "room_report_room_id_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "room"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_report" ADD CONSTRAINT "room_report_message_id_room_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "room_message"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "room_report" ADD CONSTRAINT "room_report_reporter_id_user_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_report" ADD CONSTRAINT "room_report_accused_id_user_id_fkey" FOREIGN KEY ("accused_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_realm_id_realm_id_fkey" FOREIGN KEY ("realm_id") REFERENCES "realm"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_low_user_id_user_id_fkey" FOREIGN KEY ("low_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_high_user_id_user_id_fkey" FOREIGN KEY ("high_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_key" ADD CONSTRAINT "user_key_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;