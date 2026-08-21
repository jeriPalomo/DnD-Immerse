CREATE TABLE `srd_class_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`ruleset` text DEFAULT '2014' NOT NULL,
	`class_name` text NOT NULL,
	`level` integer NOT NULL,
	`spellcasting` text,
	`class_specific` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_class_levels_idx` ON `srd_class_levels` (`ruleset`,`class_name`,`level`);--> statement-breakpoint
CREATE TABLE `srd_features` (
	`id` text PRIMARY KEY NOT NULL,
	`ruleset` text DEFAULT '2014' NOT NULL,
	`class_name` text NOT NULL,
	`subclass_name` text DEFAULT '' NOT NULL,
	`level` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`parent_name` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_features_idx` ON `srd_features` (`ruleset`,`class_name`,`level`);--> statement-breakpoint
CREATE TABLE `srd_traits` (
	`id` text PRIMARY KEY NOT NULL,
	`ruleset` text DEFAULT '2014' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`races` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_traits_idx` ON `srd_traits` (`ruleset`);--> statement-breakpoint
ALTER TABLE `actors` ADD `level_acknowledged` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Everybody who already exists has been playing their current level for a
-- while: catching them all up avoids greeting the whole party with a level-up
-- panel for a level they took three sessions ago.
UPDATE `actors` SET `level_acknowledged` = `level`;
