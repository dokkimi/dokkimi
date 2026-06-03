import {
  IsArray,
  IsString,
  IsOptional,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RegistryCredentialDto {
  @IsString()
  registryUrl!: string;

  @IsString()
  username!: string;

  @IsString()
  password!: string;
}

export class CreateRunDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  definitions!: string[];

  @IsOptional()
  @IsString()
  projectPath?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistryCredentialDto)
  registryCredentials?: RegistryCredentialDto[];
}
