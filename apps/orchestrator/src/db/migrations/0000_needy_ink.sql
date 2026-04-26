CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`stage_execution_id` text NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`schema_id` text,
	`content_hash` text NOT NULL,
	`size` integer NOT NULL,
	`preview` text,
	`storage_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`stage_execution_id`) REFERENCES `stage_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gate_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`stage_execution_id` text NOT NULL,
	`decided_by` text NOT NULL,
	`decision` text NOT NULL,
	`feedback` text,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`stage_execution_id`) REFERENCES `stage_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gate_decisions_stage_execution_unique` ON `gate_decisions` (`stage_execution_id`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`requirement_id` text NOT NULL,
	`pipeline_snapshot_json` text NOT NULL,
	`sandbox_session_id` text,
	`per_repo_branches_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pipeline_runs_requirement_idx` ON `pipeline_runs` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_pipeline_id` text,
	`sandbox_config_json` text NOT NULL,
	`claude_config_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`pr_url` text NOT NULL,
	`pr_number` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_run_repo_unique` ON `pull_requests` (`run_id`,`repo_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`git_url` text NOT NULL,
	`default_branch` text NOT NULL,
	`working_dir` text NOT NULL,
	`test_command` text,
	`pr_template` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_project_name_unique` ON `repos` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`status` text NOT NULL,
	`current_stage_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `requirements_project_status_idx` ON `requirements` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `stage_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`status` text NOT NULL,
	`claude_subprocess_pid` integer,
	`claude_session_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`events_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stage_executions_run_idx` ON `stage_executions` (`run_id`);