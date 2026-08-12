ALTER TABLE `campaigns` ADD `ruleset` text DEFAULT '2014' NOT NULL;--> statement-breakpoint
ALTER TABLE `scenes` ADD `weather` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `scenes` ADD `weather_intensity` real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `srd_items` ADD `ruleset` text DEFAULT '2014' NOT NULL;--> statement-breakpoint
ALTER TABLE `srd_monsters` ADD `ruleset` text DEFAULT '2014' NOT NULL;--> statement-breakpoint
ALTER TABLE `srd_spells` ADD `ruleset` text DEFAULT '2014' NOT NULL;--> statement-breakpoint
ALTER TABLE `tokens` ADD `light_color` text DEFAULT '#ffb46b' NOT NULL;