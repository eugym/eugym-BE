// ─── User Roles (mirror frontend) ────────────────────────────────────────────
export type UserRole =
  | 'visitor' | 'regular' | 'standard' | 'premium'
  | 'trainer' | 'corporate_admin' | 'affiliate_partner'
  | 'admin' | 'super_admin'

export type SubscriptionTier     = 'free' | 'standard' | 'premium' | 'corporate'
export type SubscriptionDuration = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'biannual' | 'annual'
export type SubscriptionStatus   = 'active' | 'expired' | 'cancelled' | 'pending'
export type BookingStatus        = 'confirmed' | 'cancelled' | 'completed' | 'no_show'
export type BookingType          = 'group_class' | 'pt_session'
export type ClassLevel           = 'beginner' | 'intermediate' | 'advanced'
export type ProductCategory      = 'fitness_wear' | 'accessories' | 'supplements' | 'wellness' | 'branded'
export type ProductStatus        = 'active' | 'inactive' | 'out_of_stock'
export type OrderStatus          = 'pending_payment' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'
export type PaymentMethod        = 'card' | 'bank_transfer' | 'pos' | 'ussd'
export type PaymentStatus        = 'pending' | 'success' | 'failed' | 'refunded'
export type SettlementStatus     = 'pending' | 'processed' | 'disputed'

// ─── DB Row Types (snake_case from postgres) ──────────────────────────────────
export type UserRow = {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string
  password_hash: string | null
  role: UserRole
  avatar: string | null
  centre_id: string | null
  trainer_id: string | null
  corporate_id: string | null
  is_email_verified: boolean
  is_2fa_enabled: boolean
  two_fa_secret: string | null
  google_id: string | null
  strike_count: number
  booking_suspended_until: Date | null
  last_login_at: Date | null
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export type SubscriptionRow = {
  id: string
  user_id: string
  tier: SubscriptionTier
  duration: SubscriptionDuration
  status: SubscriptionStatus
  start_date: Date | null
  end_date: Date | null
  amount_paid: number
  auto_renew: boolean
  centre_id: string | null
  paystack_ref: string | null
  cancelled_at: Date | null
  created_at: Date
  updated_at: Date
}

export type RefreshTokenRow = {
  id: string
  user_id: string
  token_hash: string
  expires_at: Date
  created_at: Date
  revoked_at: Date | null
}

export type TrainerProfileRow = {
  id: string
  user_id: string
  centre_id: string
  bio: string | null
  specialisations: string[]
  certifications: string[]
  rating: number
  review_count: number
  client_count: number
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export type FitnessClassRow = {
  id: string
  centre_id: string
  trainer_id: string
  name: string
  description: string | null
  category: string
  level: ClassLevel
  start_time: Date
  duration_mins: number
  capacity: number
  enrolled: number
  is_cancelled: boolean
  recurrence: string | null
  created_at: Date
  updated_at: Date
}

export type BookingRow = {
  id: string
  user_id: string
  class_id: string | null
  trainer_id: string | null
  type: BookingType
  status: BookingStatus
  scheduled_at: Date
  duration_mins: number
  notes: string | null
  cancelled_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

export type ProductRow = {
  id: string
  name: string
  description: string | null
  category: ProductCategory
  price: number
  images: string[]
  sku: string
  stock: number
  status: ProductStatus
  created_at: Date
  updated_at: Date
}

export type ProductVariantRow = {
  id: string
  product_id: string
  label: string
  stock: number
  price_modifier: number
  created_at: Date
}

export type OrderRow = {
  id: string
  user_id: string | null
  guest_email: string | null
  guest_phone: string | null
  first_name: string
  last_name: string
  address: string
  city: string
  state: string
  subtotal: number
  delivery_fee: number
  total: number
  status: OrderStatus
  paystack_ref: string | null
  shipped_at: Date | null
  delivered_at: Date | null
  created_at: Date
  updated_at: Date
}

export type CentreRow = {
  id: string
  name: string
  address: string
  city: string
  state: string
  lat: number | null
  lng: number | null
  capacity: number
  is_affiliate: boolean
  affiliate_id: string | null
  images: string[]
  amenities: string[]
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export type AffiliateRow = {
  id: string
  name: string
  contact_name: string
  contact_email: string
  contact_phone: string
  rate_per_visit: number
  bank_name: string | null
  bank_account: string | null
  bank_code: string | null
  is_active: boolean
  agreement_start: Date | null
  agreement_end: Date | null
  created_at: Date
  updated_at: Date
}

export type AffiliateVisitRow = {
  id: string
  user_id: string
  centre_id: string
  affiliate_id: string
  visited_at: Date
  settled: boolean
  settlement_id: string | null
}

export type PaymentRow = {
  id: string
  user_id: string
  subscription_id: string | null
  order_id: string | null
  amount: number
  method: PaymentMethod
  status: PaymentStatus
  paystack_ref: string | null
  paystack_data: Record<string, unknown> | null
  pos_confirmed_by: string | null
  pos_proof_url: string | null
  paid_at: Date | null
  created_at: Date
}

// ─── API Response shape (mirrors frontend ApiResponse<T>) ─────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean
  data:    T
  message?: string
  errors?: Record<string, string[]>
}

export interface PaginatedResult<T> {
  data:        T[]
  total:       number
  page:        number
  limit:       number
  totalPages:  number
}

// ─── JWT payload ──────────────────────────────────────────────────────────────
export interface JwtPayload {
  sub:   string   // user ID
  role:  UserRole
  email: string
  iat?:  number
  exp?:  number
}

// ─── Express augmentation ─────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: UserRole; email: string }
    }
  }
}
