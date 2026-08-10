CREATE TABLE `active_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_actor_id` text,
	`owner_item_id` text,
	`owner_token_id` text,
	`name` text NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`changes` text NOT NULL,
	`duration` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`transfer` integer DEFAULT true NOT NULL,
	`status_id` text,
	FOREIGN KEY (`owner_actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `effects_actor_idx` ON `active_effects` (`owner_actor_id`);--> statement-breakpoint
CREATE INDEX `effects_token_idx` ON `active_effects` (`owner_token_id`);--> statement-breakpoint
CREATE TABLE `actor_campaigns` (
	`actor_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`assigned_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`actor_id`, `campaign_id`),
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actor_campaigns_campaign_idx` ON `actor_campaigns` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`campaign_id` text,
	`type` text DEFAULT 'character' NOT NULL,
	`name` text NOT NULL,
	`portrait_url` text,
	`class_name` text DEFAULT '' NOT NULL,
	`subclass` text DEFAULT '' NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`race` text DEFAULT '' NOT NULL,
	`background` text DEFAULT '' NOT NULL,
	`alignment` text DEFAULT '' NOT NULL,
	`experience` integer DEFAULT 0 NOT NULL,
	`challenge_rating` text DEFAULT '' NOT NULL,
	`str` integer DEFAULT 10 NOT NULL,
	`dex` integer DEFAULT 10 NOT NULL,
	`con` integer DEFAULT 10 NOT NULL,
	`int` integer DEFAULT 10 NOT NULL,
	`wis` integer DEFAULT 10 NOT NULL,
	`cha` integer DEFAULT 10 NOT NULL,
	`armor_class` integer DEFAULT 10 NOT NULL,
	`speed` integer DEFAULT 30 NOT NULL,
	`hp_current` integer DEFAULT 1 NOT NULL,
	`hp_max` integer DEFAULT 1 NOT NULL,
	`hp_temp` integer DEFAULT 0 NOT NULL,
	`hit_dice_total` text DEFAULT '1d8' NOT NULL,
	`hit_dice_used` integer DEFAULT 0 NOT NULL,
	`death_save_successes` integer DEFAULT 0 NOT NULL,
	`death_save_failures` integer DEFAULT 0 NOT NULL,
	`inspiration` integer DEFAULT false NOT NULL,
	`spellcasting_ability` text,
	`skill_proficiencies` text NOT NULL,
	`save_proficiencies` text NOT NULL,
	`spell_slots` text NOT NULL,
	`currency` text NOT NULL,
	`damage_modifiers` text NOT NULL,
	`prototype_token` text NOT NULL,
	`other_proficiencies` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`appearance` text DEFAULT '' NOT NULL,
	`backstory` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actors_owner_idx` ON `actors` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `actors_campaign_idx` ON `actors` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `ambient_sounds` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`file_url` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`radius` real DEFAULT 10 NOT NULL,
	`volume` real DEFAULT 0.7 NOT NULL,
	`blocked_by_walls` integer DEFAULT true NOT NULL,
	`easing` integer DEFAULT true NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ambient_sounds_scene_idx` ON `ambient_sounds` (`scene_id`);--> statement-breakpoint
CREATE TABLE `audio_state` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`playlist_id` text,
	`track_id` text,
	`playing` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`volume` real DEFAULT 0.6 NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`track_id`) REFERENCES `playlist_tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `campaign_members` (
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'player' NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`campaign_id`, `user_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `members_user_idx` ON `campaign_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`dm_user_id` text NOT NULL,
	`active_scene_id` text,
	`invite_code` text NOT NULL,
	`banner_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`dm_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_invite_code_unique` ON `campaigns` (`invite_code`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`roll_data` text,
	`card_data` text,
	`whisper_to_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`whisper_to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_campaign_created_idx` ON `chat_messages` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `encounters` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`scene_id` text,
	`round` integer DEFAULT 1 NOT NULL,
	`active_index` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `encounters_campaign_idx` ON `encounters` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `fog_exploration` (
	`scene_id` text NOT NULL,
	`user_id` text NOT NULL,
	`grid_width` integer DEFAULT 0 NOT NULL,
	`grid_height` integer DEFAULT 0 NOT NULL,
	`explored_bitmap` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`scene_id`, `user_id`),
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `initiative_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`encounter_id` text NOT NULL,
	`token_id` text,
	`name` text NOT NULL,
	`initiative` real DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`encounter_id`) REFERENCES `encounters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `initiative_encounter_idx` ON `initiative_entries` (`encounter_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_actor_id` text,
	`campaign_id` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`image_url` text,
	`system` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_owner_actor_idx` ON `items` (`owner_actor_id`);--> statement-breakpoint
CREATE INDEX `items_campaign_type_idx` ON `items` (`campaign_id`,`type`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`title` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `journal_campaign_idx` ON `journal_entries` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `journal_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`body_markdown` text DEFAULT '' NOT NULL,
	`file_url` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `journal_pages_entry_idx` ON `journal_pages` (`entry_id`);--> statement-breakpoint
CREATE TABLE `lights` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`bright_radius` real DEFAULT 0 NOT NULL,
	`dim_radius` real DEFAULT 0 NOT NULL,
	`color` text DEFAULT '#ffffff' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lights_scene_idx` ON `lights` (`scene_id`);--> statement-breakpoint
CREATE TABLE `map_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`journal_page_id` text,
	`label` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT 'pin' NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`hidden` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`journal_page_id`) REFERENCES `journal_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `map_notes_scene_idx` ON `map_notes` (`scene_id`);--> statement-breakpoint
CREATE TABLE `ownership` (
	`document_type` text NOT NULL,
	`document_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_type`, `document_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ownership_user_idx` ON `ownership` (`user_id`);--> statement-breakpoint
CREATE TABLE `playlist_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`file_url` text NOT NULL,
	`volume` real DEFAULT 0.7 NOT NULL,
	`loop` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_tracks_playlist_idx` ON `playlist_tracks` (`playlist_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'sequential' NOT NULL,
	`fade_ms` integer DEFAULT 1500 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlists_campaign_idx` ON `playlists` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`map_image_url` text,
	`map_width` integer DEFAULT 0 NOT NULL,
	`map_height` integer DEFAULT 0 NOT NULL,
	`grid_size` real DEFAULT 70 NOT NULL,
	`grid_offset_x` real DEFAULT 0 NOT NULL,
	`grid_offset_y` real DEFAULT 0 NOT NULL,
	`grid_visible` integer DEFAULT true NOT NULL,
	`feet_per_square` integer DEFAULT 5 NOT NULL,
	`vision_enabled` integer DEFAULT false NOT NULL,
	`global_illumination` integer DEFAULT true NOT NULL,
	`darkness` real DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenes_campaign_idx` ON `scenes` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `srd_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`item_type` text DEFAULT 'equipment' NOT NULL,
	`cost` text DEFAULT '' NOT NULL,
	`weight` real DEFAULT 0 NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`system` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_items_name_idx` ON `srd_items` (`name`);--> statement-breakpoint
CREATE TABLE `srd_monsters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`size` text DEFAULT '' NOT NULL,
	`type` text DEFAULT '' NOT NULL,
	`alignment` text DEFAULT '' NOT NULL,
	`armor_class` integer DEFAULT 10 NOT NULL,
	`hit_points` integer DEFAULT 1 NOT NULL,
	`hit_dice` text DEFAULT '' NOT NULL,
	`speed` text DEFAULT '' NOT NULL,
	`str` integer DEFAULT 10 NOT NULL,
	`dex` integer DEFAULT 10 NOT NULL,
	`con` integer DEFAULT 10 NOT NULL,
	`int` integer DEFAULT 10 NOT NULL,
	`wis` integer DEFAULT 10 NOT NULL,
	`cha` integer DEFAULT 10 NOT NULL,
	`challenge_rating` text DEFAULT '0' NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`token_size` real DEFAULT 1 NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_monsters_name_idx` ON `srd_monsters` (`name`);--> statement-breakpoint
CREATE INDEX `srd_monsters_cr_idx` ON `srd_monsters` (`challenge_rating`);--> statement-breakpoint
CREATE TABLE `srd_spells` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`level` integer NOT NULL,
	`school` text DEFAULT '' NOT NULL,
	`casting_time` text DEFAULT '' NOT NULL,
	`range` text DEFAULT '' NOT NULL,
	`components` text DEFAULT '' NOT NULL,
	`duration` text DEFAULT '' NOT NULL,
	`concentration` integer DEFAULT false NOT NULL,
	`ritual` integer DEFAULT false NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`higher_level` text DEFAULT '' NOT NULL,
	`classes` text NOT NULL,
	`system` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `srd_spells_level_idx` ON `srd_spells` (`level`);--> statement-breakpoint
CREATE INDEX `srd_spells_name_idx` ON `srd_spells` (`name`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`owner_user_id` text,
	`shape` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`direction` real DEFAULT 0 NOT NULL,
	`distance` real DEFAULT 0 NOT NULL,
	`angle` real DEFAULT 53 NOT NULL,
	`width` real DEFAULT 0 NOT NULL,
	`color` text DEFAULT '#4a9eff' NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_scene_idx` ON `templates` (`scene_id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`image_url` text,
	`actor_id` text,
	`actor_linked` integer DEFAULT false NOT NULL,
	`owner_user_id` text,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`w` real DEFAULT 1 NOT NULL,
	`h` real DEFAULT 1 NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`layer` text DEFAULT 'token' NOT NULL,
	`disposition` text DEFAULT 'hostile' NOT NULL,
	`vision_range` real DEFAULT 0 NOT NULL,
	`darkvision_range` real DEFAULT 0 NOT NULL,
	`light_bright` real DEFAULT 0 NOT NULL,
	`light_dim` real DEFAULT 0 NOT NULL,
	`hp` integer,
	`max_hp` integer,
	`ac` integer,
	`conditions` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tokens_scene_idx` ON `tokens` (`scene_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`avatar_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `walls` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`x1` real NOT NULL,
	`y1` real NOT NULL,
	`x2` real NOT NULL,
	`y2` real NOT NULL,
	`blocks_movement` integer DEFAULT 1 NOT NULL,
	`blocks_sight` integer DEFAULT 1 NOT NULL,
	`blocks_sound` integer DEFAULT 0 NOT NULL,
	`door` integer DEFAULT 0 NOT NULL,
	`door_state` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `walls_scene_idx` ON `walls` (`scene_id`);