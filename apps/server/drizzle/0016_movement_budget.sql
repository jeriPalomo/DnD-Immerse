ALTER TABLE `tokens` ADD `turn_origin_x` real;--> statement-breakpoint
ALTER TABLE `tokens` ADD `turn_origin_y` real;--> statement-breakpoint
ALTER TABLE `tokens` ADD `extra_move_feet` real DEFAULT 0 NOT NULL;
