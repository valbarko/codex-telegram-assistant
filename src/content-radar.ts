export type ContentRadarSourceKind = "telegram" | "website";
export type ContentRadarSourceRole = "evidence" | "expert" | "trend" | "behavior";

export interface ContentRadarPost {
  sourceId: string;
  sourceKind: ContentRadarSourceKind;
  sourceRole: ContentRadarSourceRole;
  sourceTitle: string;
  publishedAt: number;
  text: string;
  links?: readonly string[];
  sourceUrl?: string;
}
