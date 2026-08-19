CREATE TABLE `scene_terrain` (
	`scene_id` text PRIMARY KEY NOT NULL,
	`grid_width` integer DEFAULT 0 NOT NULL,
	`grid_height` integer DEFAULT 0 NOT NULL,
	`blocked_bitmap` text DEFAULT '' NOT NULL,
	`difficult_bitmap` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
