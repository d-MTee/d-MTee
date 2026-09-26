import type {Quote,Token,Venue} from '../core/types.js';
export interface QuoteProvider{ readonly venue:Venue; quote(input:Token,output:Token,amount:number):Promise<Quote> }
