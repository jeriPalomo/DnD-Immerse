ALTER TABLE `scene_terrain` RENAME COLUMN `difficult_bitmap` TO `mud_bitmap`;--> statement-breakpoint
ALTER TABLE `scene_terrain` ADD `water_bitmap` text DEFAULT '' NOT NULL;
