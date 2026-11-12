export type KeyStatus = 'hidden' | 'revealed' | 'unavailable' | 'external';

export interface KeyItem {
  id: string;
  title: string;
  platform: string;
  key: string | null;
  status: KeyStatus;
  instructions?: string;
  redeemUrl?: string;
}

export interface Bundle {
  id: string;
  title: string;
  imageUrl: string;
  purchasedAt?: string;
  items: KeyItem[];
  detailsFailed?: boolean;
  sourceUrl?: string | null;
  recovered?: boolean;
}

export interface LibraryStatus {
  connected: boolean;
  bundles: Bundle[];
  lastSync?: string | null;
  warning?: string | null;
  enumerationComplete?: boolean;
}
