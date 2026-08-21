CREATE TABLE `actor_subclass_features` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`subclass_name` text NOT NULL,
	`level` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actor_subclass_features_idx` ON `actor_subclass_features` (`actor_id`,`level`);
