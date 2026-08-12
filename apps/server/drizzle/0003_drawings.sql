CREATE TABLE `drawings` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`owner_user_id` text,
	`kind` text DEFAULT 'freehand' NOT NULL,
	`points` text NOT NULL,
	`color` text DEFAULT '#e8853f' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`width` real DEFAULT 3 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drawings_scene_idx` ON `drawings` (`scene_id`);