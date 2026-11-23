export type TDirection = "up" | "down" | "left" | "right";
export type TAlign = "start" | "center" | "end";

interface ISize {
  w: number;
  h: number;
}

export interface IRect extends ISize {
  x: number;
  y: number;
  r: number;
}

export interface IGeo {
  layerW: number;
  layerH: number;
  left: number;
  top: number;
  fab: IRect;
  slots: IRect[];
}

export interface IGeoConfig {
  triggerSize: ISize;
  items: (ISize & { radius?: number })[];
  direction: TDirection;
  align: TAlign;
  sideOffset: number;
  spacing: number;
  itemRadius: number;
  triggerRadius: number;
  padding: number;
}
