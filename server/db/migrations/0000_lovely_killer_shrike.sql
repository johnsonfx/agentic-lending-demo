CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state` text NOT NULL,
	`history` text NOT NULL,
	`msgs` text NOT NULL,
	`trace` text NOT NULL
);
