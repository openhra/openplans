export class ReadError extends Error {
  constructor(
    readonly error: {
      code: string;
      field?: string;
      message?: string;
      plan_id?: string;
      year?: number;
    },
  ) {
    super(error.code);
  }
}
