ALTER TABLE `actors` ADD `srd_monster_id` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `players_see_enemy_stats` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tokens` ADD `stats_hidden` integer DEFAULT false NOT NULL;